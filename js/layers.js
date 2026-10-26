/* ============================================================================
   layers.js —— 地图图层：风场粒子 / 气温 / 降水 / 云量 / 雷达 / 等高线
   参考 Windy 的左侧图层栏；所有绘制都在一块覆盖地图的 canvas 上，
   坐标用高德的 lngLatToContainer 投影，移动地图时重投影。
   ========================================================================== */
(function () {
  'use strict';

  /* 只保留风场一个图层；以后加图层往这里追加即可 */
  var MODES = [
    { id: 'wind', label: '风场', icon: '≋' }
  ];

  var S = {
    mode: 'aqi',
    map: null,
    wrap: null,
    cv: null, ctx: null,
    cc: null, cctx: null,           /* 等高线单独一层 */
    W: 0, H: 0, dpr: 1,
    grid: null,                     /* {cols, rows, px:[], py:[], val:[], u:[], v:[]} */
    parts: [],
    raf: 0,
    weather: null,                  /* 城市气象 */
    timer: 0
  };

  /* ---------------- 气象数据（Open-Meteo 多点一次拿回） ---------------- */
  function fetchWeather(cities, cb) {
    var k = 'aq_weather_v1', cached = null;
    try {
      var o = JSON.parse(localStorage.getItem(k) || 'null');
      if (o && Date.now() - o.t < 600000) cached = o.d;
    } catch (e) {}
    if (cached && cached.length) { S.weather = cached; cb(cached); return; }

    var list = cities.slice(0, 90);
    var lat = list.map(function (c) { return c.lat.toFixed(2); }).join(',');
    var lng = list.map(function (c) { return c.lng.toFixed(2); }).join(',');
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
      '&current=temperature_2m,precipitation,cloud_cover,relative_humidity_2m,wind_speed_10m,wind_direction_10m' +
      '&timezone=Asia%2FShanghai';

    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var arr = Array.isArray(j) ? j : [j];
      var out = arr.map(function (x, i) {
        var c = x.current || {};
        return {
          name: list[i] ? list[i].name : '',
          lat: list[i] ? list[i].lat : 0,
          lng: list[i] ? list[i].lng : 0,
          temp: c.temperature_2m,
          rain: c.precipitation,
          cloud: c.cloud_cover,
          rh: c.relative_humidity_2m,
          ws: c.wind_speed_10m,
          wd: c.wind_direction_10m
        };
      }).filter(function (d) { return isFinite(d.temp); });
      S.weather = out;
      try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d: out })); } catch (e) {}
      cb(out);
    }).catch(function () { cb([]); });
  }

  /* ---------------- 投影 & 网格 ---------------- */
  function project(lng, lat) {
    if (S.map && S.map.lngLatToContainer) {
      var p = S.map.lngLatToContainer([lng, lat]);
      if (p) return [p.getX ? p.getX() : p.x, p.getY ? p.getY() : p.y];
    }
    return null;
  }

  function bounds() {
    if (S.map && S.map.getBounds) {
      var b = S.map.getBounds();
      return { w: b.getSouthWest().getLng(), s: b.getSouthWest().getLat(), e: b.getNorthEast().getLng(), n: b.getNorthEast().getLat() };
    }
    return { w: 73, s: 15, e: 135, n: 54 };
  }

  function idw(points, key, lng, lat) {
    var sw = 0, sv = 0;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var dx = p.lng - lng, dy = p.lat - lat;
      var d2 = dx * dx + dy * dy + 0.06;
      var w = 1 / (d2 * d2);
      sv += (p[key] || 0) * w;
      sw += w;
    }
    return sw ? sv / sw : 0;
  }

  function buildGrid() {
    var b = bounds(), COLS = 34, ROWS = 24;
    var px = [], py = [], val = [], u = [], v = [];
    var cities = (window.AQApp && window.AQApp.data()) || [];
    var w = S.weather || [];

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var lng = b.w + (b.e - b.w) * c / (COLS - 1);
        var lat = b.s + (b.n - b.s) * r / (ROWS - 1);
        var p = project(lng, lat);
        px.push(p ? p[0] : -9999);
        py.push(p ? p[1] : -9999);

        if (S.mode === 'wind') {
          if (w.length) {
            var ws = idw(w, 'ws', lng, lat);
            var wd = idw(w, 'wd', lng, lat);
            var rad = (wd + 180) * Math.PI / 180;   /* 风向是"来向"，粒子要去向 */
            u.push(-Math.sin(rad) * ws * 0.28);
            v.push(-Math.cos(rad) * ws * 0.28);
          } else {
            u.push(Math.sin(lat * 0.6) * 0.9);
            v.push(Math.cos(lng * 0.5) * 0.7);
          }
        } else if (S.mode === 'temp') {
          val.push(w.length ? idw(w, 'temp', lng, lat) : (32 - Math.abs(lat - 22) * 0.9));
        } else if (S.mode === 'rain') {
          val.push(w.length ? idw(w, 'rain', lng, lat) : 0);
        } else if (S.mode === 'cloud') {
          val.push(w.length ? idw(w, 'cloud', lng, lat) : 0);
        } else if (S.mode === 'humidity') {
          val.push(w.length ? idw(w, 'rh', lng, lat) : 60);
        } else {
          val.push(cities.length ? idw(cities, 'aqi', lng, lat) : 60);
        }
      }
    }
    S.grid = { cols: COLS, rows: ROWS, px: px, py: py, val: val, u: u, v: v };
  }

  /* ---------------- 等高线（marching squares） ---------------- */
  function drawContour() {
    var g = S.grid, ctx = S.cctx;
    ctx.clearRect(0, 0, S.W, S.H);
    if (!g || !g.val.length) return;
    var mn = Infinity, mx = -Infinity;
    g.val.forEach(function (v) { if (v < mn) mn = v; if (v > mx) mx = v; });
    if (!isFinite(mn) || mx - mn < 1) return;

    var LEVELS = 8;
    for (var L = 1; L <= LEVELS; L++) {
      var lv = mn + (mx - mn) * L / (LEVELS + 1);
      ctx.beginPath();
      for (var r = 0; r < g.rows - 1; r++) {
        for (var c = 0; c < g.cols - 1; c++) {
          var i0 = r * g.cols + c, i1 = i0 + 1, i2 = i0 + g.cols, i3 = i2 + 1;
          var v0 = g.val[i0], v1 = g.val[i1], v2 = g.val[i2], v3 = g.val[i3];
          var pts = [];
          function lerp(a, b, va, vb) { var t = (lv - va) / (vb - va || 1e-6); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
          var p00 = [g.px[i0], g.py[i0]], p10 = [g.px[i1], g.py[i1]],
              p01 = [g.px[i2], g.py[i2]], p11 = [g.px[i3], g.py[i3]];
          if ((v0 < lv) !== (v1 < lv)) pts.push(lerp(p00, p10, v0, v1));
          if ((v1 < lv) !== (v3 < lv)) pts.push(lerp(p10, p11, v1, v3));
          if ((v2 < lv) !== (v3 < lv)) pts.push(lerp(p01, p11, v2, v3));
          if ((v0 < lv) !== (v2 < lv)) pts.push(lerp(p00, p01, v0, v2));
          if (pts.length >= 2) {
            ctx.moveTo(pts[0][0], pts[0][1]);
            ctx.lineTo(pts[1][0], pts[1][1]);
          }
        }
      }
      var a = 0.26 + 0.55 * (L / LEVELS);
      ctx.strokeStyle = 'rgba(140,232,255,' + a.toFixed(2) + ')';
      ctx.lineWidth = 1.15;
      ctx.stroke();
    }
  }

  /* ---------------- 填色层（气温/降水/云量） ---------------- */
  function drawField() {
    var g = S.grid, ctx = S.ctx;
    if (!g || !g.val.length) return;
    var mn = Infinity, mx = -Infinity;
    g.val.forEach(function (v) { if (v < mn) mn = v; if (v > mx) mx = v; });
    var span = (mx - mn) || 1;
    var step = 14;
    for (var y = 0; y < S.H; y += step) {
      for (var x = 0; x < S.W; x += step) {
        var c = Math.min(g.cols - 1, Math.round(x / S.W * (g.cols - 1)));
        var r = Math.min(g.rows - 1, Math.round(y / S.H * (g.rows - 1)));
        var v = g.val[r * g.cols + c];
        var t = (v - mn) / span;
        var col = colorOf(t);
        ctx.fillStyle = col;
        ctx.fillRect(x, y, step + 1, step + 1);
      }
    }
  }

  function colorOf(t) {
    /* 蓝 → 青 → 绿 → 黄 → 橙 → 红 */
    var stops = [
      [0.00, 40, 90, 190], [0.22, 50, 170, 210], [0.42, 60, 200, 160],
      [0.60, 210, 220, 90], [0.78, 240, 150, 70], [1.00, 235, 70, 80]
    ];
    for (var i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) {
        var k = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        var a = stops[i], b = stops[i + 1];
        return 'rgba(' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' +
          Math.round(a[2] + (b[2] - a[2]) * k) + ',' +
          Math.round(a[3] + (b[3] - a[3]) * k) + ',0.28)';
      }
    }
    return 'rgba(0,0,0,0)';
  }

  /* ---------------- 主循环 ---------------- */
  function frame() {
    S.raf = 0;
    if (!S.ctx) return;
    var ctx = S.ctx;

    if (S.mode === 'wind') {
      /* 风场粒子统一交给 windfield.js（Window.WindLayer）绘制。
         这里以前也画了一套 1400 个屏幕空间粒子，两套叠在一起就是那种
         "毛线团 + 风流圈"的效果 —— 现在只清空本层，避免双渲染。 */
      ctx.clearRect(0, 0, S.W, S.H);
    } else if (S.mode === 'temp' || S.mode === 'rain' || S.mode === 'cloud') {
      ctx.clearRect(0, 0, S.W, S.H);
      drawField();
    } else {
      ctx.clearRect(0, 0, S.W, S.H);
    }

    if (S.mode === 'contour') { /* DEM 自己画，这里不重复 */ }
    else S.cctx.clearRect(0, 0, S.W, S.H);

    S.raf = requestAnimationFrame(frame);
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    var wrap = S.wrap;
    if (!wrap) return;
    var r = wrap.getBoundingClientRect();
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    S.W = r.width; S.H = r.height;
    [S.cv, S.cc].forEach(function (cv) {
      cv.width = S.W * S.dpr; cv.height = S.H * S.dpr;
      cv.style.width = S.W + 'px'; cv.style.height = S.H + 'px';
    });
    S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    S.cctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    buildGrid();
  }

  function rebuild() {
    buildGrid();
    if (S.mode === 'contour') drawContour();
  }

  /* ---------------- 对外 ---------------- */
  function setMode(id) {
    S.mode = id;

    if (window.WindLayer) window.WindLayer.setVisible(id === 'wind');
    /* 卫星底图常开；风场是唯一开关；等高线跟着卫星常开 */
    /* 开风场时关掉城市黄环，关风场再恢复 */
    if (window.BaseMap && window.BaseMap.setHeat) window.BaseMap.setHeat(id !== 'wind');
    if (window.BaseMap && window.BaseMap.setSatellite) window.BaseMap.setSatellite(false);
    if (window.DEM) window.DEM.setVisible(false);

    S.ctx.clearRect(0, 0, S.W, S.H);
    S.cctx.clearRect(0, 0, S.W, S.H);
    document.querySelectorAll('.layer-rail button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.layer === id);
    });
    buildGrid();
    if (id === 'contour' && window.DEM) window.DEM.redraw();
    var tag = document.getElementById('layerTag');
    if (tag) {
      var m = MODES.filter(function (x) { return x.id === id; })[0];
      tag.textContent = m ? m.label : '';
      tag.classList.toggle('on', id !== 'aqi');
    }
  }

  function renderRail() {
    var rail = document.getElementById('layerRail');
    if (!rail) return;
    rail.innerHTML = MODES.map(function (m) {
      return '<button type="button" data-layer="' + m.id + '" title="' + m.label + '">' +
        '<i>' + m.icon + '</i><span>' + m.label + '</span></button>';
    }).join('');
    rail.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var on = !b.classList.contains('on');
      setMode(on ? 'wind' : 'aqi');
    });
  }

  function init() {
    S.wrap = document.querySelector('.map-stage');
    if (!S.wrap) return false;
    S.cv = document.createElement('canvas');
    S.cv.className = 'fx-canvas';
    S.cc = document.createElement('canvas');
    S.cc.className = 'fx-canvas fx-contour';
    S.wrap.appendChild(S.cc);
    S.wrap.appendChild(S.cv);
    S.ctx = S.cv.getContext('2d');
    S.cctx = S.cc.getContext('2d');

    renderRail();
    resize();
    window.addEventListener('resize', resize);

    /* 高德就绪后跟随移动重投影 */
    var tries = 0;
    (function hook() {
      var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
      if (map) {
        S.map = map;
        try {
          map.on('moveend', function () { rebuild(); if (window.DEM) setTimeout(function(){ window.DEM.redraw(); }, 120); });
          map.on('zoomend', rebuild);
        } catch (e) {}
        rebuild();
        return;
      }
      if (++tries < 40) setTimeout(hook, 400);
    })();

    /* 首屏就用卫星底图 */
    setTimeout(function () {
      if (window.BaseMap && window.BaseMap.setSatellite) window.BaseMap.setSatellite(false);
      var bg = document.querySelector('.bg-layer');
      if (bg) bg.classList.remove('satellite');
      /* 默认关等高线，保持地图干净 */
      if (window.DEM) window.DEM.setVisible(false);
    }, 2500);

    fetchWeather((window.AQApp && window.AQApp.data()) || [], rebuild);
    S.timer = setInterval(function () {
      fetchWeather((window.AQApp && window.AQApp.data()) || [], rebuild);
    }, 600000);

    S.raf = requestAnimationFrame(frame);
    return true;
  }

  window.LayerFX = { init: init, setMode: setMode, rebuild: rebuild, modes: MODES, state: S };
})();
