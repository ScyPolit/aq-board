/* ============================================================================
   windfield.js v2 —— 电视台式风场流线（CCTV 天气预报那种干净长线）
   
   和 v1 的区别（v1 是 Windy 那种短促密集的"毛线团"，v2 是电视天气预报的长流线）：
     · 粒子 6000 → 2600（少而长，才像"流线"）
     · 寿命 100 帧 → 260 帧，每帧 2 个子步（曲线更顺）
     · 拖尾擦除 0.085 → 0.032（尾巴拉长 3 倍）
     · 线段 1px 直角 → 0.9px 圆头，两档亮度（新粒子亮、老粒子淡）
     · 合成风场去掉涡旋（v1 那个以 115E/32N 为中心的旋转就是画面里"风流圈"的来源）
     · 开启时自动关掉 AQI 热区光圈（那些黄圈），关闭时恢复
   ========================================================================== */
(function () {
  'use strict';

  var grid = null;
  var cv, ctx, dpr = Math.min(2, window.devicePixelRatio || 1);
  var parts = [], W = 0, H = 0, raf = 0, last = 0, on = false, paused = false;
  var N = (window.innerWidth < 1400 ? 1200 : 2600);
  var MAX_AGE = 260;
  var flushMark = 0, flushing = false;
  var MAX_AGE = 260;
  var GKEY = 'aq_wind_grid_v7';   /* 换 key：旧的「只有中国」网格缓存作废 */
  var synth = false, heatWas = null;

  /* ---------------- 墨卡托 ---------------- */
  function merc(lng, lat) {
    var x = (lng + 180) / 360;
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  }

  function projector() {
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map) return null;
    var c = map.getCenter(), z = map.getZoom();
    var scale = 256 * Math.pow(2, z);
    var wc = merc(c.getLng(), c.getLat());
    return {
      toScreen: function (lng, lat) {
        var w = merc(lng, lat);
        return [(w[0] - wc[0]) * scale + W / 2, (w[1] - wc[1]) * scale + H / 2];
      },
      toLngLat: function (x, y) {
        var wx = (x - W / 2) / scale + wc[0];
        var wy = (y - H / 2) / scale + wc[1];
        var lng = wx * 360 - 180;
        var n = Math.PI - 2 * Math.PI * wy;
        var lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        return [lng, lat];
      }
    };
  }

  /* ---------------- 采样 ---------------- */
  function sample(lng, lat) {
    if (!grid) return [0, 0];
    var g = grid, i = 0, j = 0, L = g.lats, O = g.lons;
    while (i < L.length - 2 && lat < L[i + 1]) i++;
    while (j < O.length - 2 && lng > O[j + 1]) j++;
    var ty = (lat - L[i]) / (L[i + 1] - L[i] || 1);
    var tx = (lng - O[j]) / (O[j + 1] - O[j] || 1);
    ty = Math.max(0, Math.min(1, ty));
    tx = Math.max(0, Math.min(1, tx));
    var u = (g.u[i][j] * (1 - tx) + g.u[i][j + 1] * tx) * (1 - ty) +
            (g.u[i + 1][j] * (1 - tx) + g.u[i + 1][j + 1] * tx) * ty;
    var v = (g.v[i][j] * (1 - tx) + g.v[i][j + 1] * tx) * (1 - ty) +
            (g.v[i + 1][j] * (1 - tx) + g.v[i + 1][j + 1] * tx) * ty;
    return [u, v];
  }

  /* ---------------- 数据 ---------------- */
  function synthetic() {
    /* 干净的风带：西风 + 轻微蛇形，不再放涡旋（涡旋就是"风流圈"） */
    var lats = [], lons = [], u = [], v = [];
    for (var la = 70; la >= -55; la -= 15) {
      var ur = [], vr = [];
      lats.push(la);
      for (var lo = -180; lo <= 180; lo += 30) {
        if (lats.length === 1) lons.push(lo);
        var band = 3.4 + 2.6 * Math.cos((la - 32) * 0.11);   /* 中纬度急流 */
        ur.push(band + 0.8 * Math.sin(lo * 0.12 + la * 0.2));
        vr.push(0.9 * Math.cos((lo - 105) * 0.09) - 0.5 * Math.sin((la - 30) * 0.15));
      }
      u.push(ur); v.push(vr);
    }
    return { lats: lats, lons: lons, u: u, v: v };
  }

  function parseMulti(arr, lats, lons) {
    var g = { lats: [], lons: lons.slice(), u: [], v: [] };
    for (var i = 0; i < lats.length; i++) {
      var rowU = [], rowV = [];
      g.lats.push(lats[i]);
      for (var k = 0; k < lons.length; k++) {
        var idx = i * lons.length + k;
        var x = arr[idx] || {};
        var cur = Array.isArray(x) ? {} : x;
        var sp = (cur.current && cur.current.wind_speed_10m) || 0;
        var dir = (cur.current && cur.current.wind_direction_10m) || 0;
        var rad = dir * Math.PI / 180;
        rowU.push(-sp * Math.sin(rad));
        rowV.push(-sp * Math.cos(rad));
      }
      g.u.push(rowU); g.v.push(rowV);
    }
    return g;
  }

  function fetchGrid(cb) {
    try {
      var o = JSON.parse(localStorage.getItem(GKEY) || 'null');
      if (o && Date.now() - o.t < 30 * 60000 && o.g) { grid = o.g; synth = false; cb(grid); return; }
    } catch (e) {}

    /* 全球网格：9 行 × 13 列 = 117 点，20 点/批 → 6 批 */
    var lats = [], lons = [];
    for (var la0 = 84; la0 >= -78; la0 -= 12) lats.push(la0);
    for (var lo0 = -180; lo0 <= 180; lo0 += 12) lons.push(lo0);

    var pairs = [];
    lats.forEach(function (la) { lons.forEach(function (lo) { pairs.push([la, lo]); }); });

    var chunks = [];
    for (var ci = 0; ci < pairs.length; ci += 20) chunks.push(pairs.slice(ci, ci + 20));
    var got = [], left = chunks.length;

    chunks.forEach(function (ch) {
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + ch.map(function (p) { return p[0]; }).join(',') +
        '&longitude=' + ch.map(function (p) { return p[1]; }).join(',') +
        '&current=wind_speed_10m,wind_direction_10m&models=metno_seamless&timezone=UTC';
      fetch(url).then(function (r) { return r.json(); }).then(function (j) { got.push(j); }).catch(function () { got.push(null); })
        .then(function () {
          if (--left > 0) return;
          var ok = got.filter(Boolean).length === chunks.length;
          if (!ok) { grid = synthetic(); synth = true; cb(grid); return; }
          var all = [];
          got.forEach(function (j) { all = all.concat(Array.isArray(j) ? j : [j]); });
          grid = parseMulti(all, lats, lons);
          synth = false;
          try { localStorage.setItem(GKEY, JSON.stringify({ t: Date.now(), g: grid })); } catch (e) {}
          cb(grid);
        });
    });
  }

  /* ---------------- 粒子 ---------------- */
  function inGrid(lng, lat) {
    if (!grid) return true;
    var L = grid.lats, O = grid.lons;
    return lat <= L[0] + 0.01 && lat >= L[L.length - 1] - 0.01 &&
      lng >= O[0] - 0.01 && lng <= O[O.length - 1] + 0.01;
  }

  /* 按风速分色：<3 白 / 3~8 淡青 / >8 亮青 */
  function speedColor(sp) {
    if (sp < 3) return '255,255,255';
    if (sp < 8) return '170,235,255';
    return '120,220,255';
  }

  function spawn(p, prj) {
    var ll, tries = 0;
    do {
      ll = prj.toLngLat(Math.random() * W, Math.random() * H);
      tries++;
    } while (!inGrid(ll[0], ll[1]) && tries < 12);
    p.lng = ll[0]; p.lat = ll[1];
    p.age = (Math.random() * MAX_AGE) | 0;
    var s = prj.toScreen(p.lng, p.lat);
    p.x = s[0]; p.y = s[1];
    return p;
  }

  function respawnAll() { parts.forEach(function (p) { p.age = MAX_AGE; }); }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    try { return frameInner(ts); } catch (e) { window.__windErr = String(e && e.message || e); }
  }

  function frameInner(ts) {
    if (!on || paused || dragPause || document.hidden) return;
    if (ts - last < 33) return;                 /* 30fps 上限 */
    last = ts;
    var prj = projector();
    if (!prj || !grid) return;

    var map = window.BaseMap.getMap();
    if (map.getPitch && map.getPitch() > 12) {  /* 抬头时墨卡托线性投影会偏 */
      paused = true;
      setTimeout(function () { paused = false; }, 1200);
      return;
    }

    /* 每 3.6 秒把擦除调到 0.12 持续 0.5 秒 —— 电视上那种周期性刷新 */
    var nowT = (window.performance && performance.now) ? performance.now() : Date.now();
    if (nowT - flushMark > 3600) { flushMark = nowT; flushing = true; }
    if (flushing && nowT - flushMark > 480) flushing = false;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = flushing ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.032)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    /* 全球网格不需要裁剪，去掉以免把东半球切掉 */

    var k = Math.min(2.2, Math.max(.5, map.getZoom() / 5.2));
    ctx.lineWidth = 0.9;
    ctx.lineCap = 'round';

    /* 6 个桶：3 档风速 × 2 段年龄；陆地整体降透明度 */
    var buckets = {};
    function push(key, a, b) {
      (buckets[key] || (buckets[key] = [])).push(a[0], a[1], b[0], b[1]);
    }

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var uv = sample(p.lng, p.lat);
      var sp = Math.sqrt(uv[0] * uv[0] + uv[1] * uv[1]);
      var nx = p.lng + uv[0] * 0.016 * k;
      var ny = p.lat + uv[1] * 0.016 * k;
      var sc = prj.toScreen(nx, ny);

      var old = p.age > MAX_AGE * 0.45;
      var land = window.DEM && window.DEM.isLand ? window.DEM.isLand(p.lng, p.lat) : false;
      var key = (sp < 3 ? 'w' : sp < 8 ? 'l' : 'h') + (old ? '2' : '1') + (land ? 'L' : 'S');
      push(key, [p.x, p.y], sc);

      p.x = sc[0]; p.y = sc[1]; p.lng = nx; p.lat = ny;
      if (++p.age > MAX_AGE || p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40 ||
          !inGrid(p.lng, p.lat)) {
        spawn(p, prj);
      }
    }

    Object.keys(buckets).forEach(function (key) {
      var arr = buckets[key];
      var col = key[0] === 'w' ? '255,255,255' : key[0] === 'l' ? '170,235,255' : '120,220,255';
      var base = key[1] === '1' ? 0.60 : 0.26;       /* 新线亮、老线淡 */
      var alpha = base * (key[2] === 'L' ? 0.6 : 1.0);  /* 陆地更淡 */
      ctx.strokeStyle = 'rgba(' + col + ',' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      for (var j = 0; j < arr.length; j += 4) {
        ctx.moveTo(arr[j], arr[j + 1]);
        ctx.lineTo(arr[j + 2], arr[j + 3]);
      }
      ctx.stroke();
    });

    if (grid) ctx.restore();
  }

  function resize() {
    var host = document.getElementById('baseMap');
    if (!host || !cv) return;
    W = host.clientWidth || host.offsetWidth;
    H = host.clientHeight || host.offsetHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    respawnAll();
  }

  function ensureCanvas() {
    if (cv) return;
    var host = document.getElementById('baseMap');
    if (!host) return;
    cv = document.createElement('canvas');
    cv.className = 'wind-canvas';
    cv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3';
    host.appendChild(cv);
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(frame);
  }

  /* 开风场时把 AQI 热区光圈关掉（就是那圈黄环），关掉时恢复 */
  function heat(show) {
    if (window.BaseMap && window.BaseMap.setHeat) {
      try { window.BaseMap.setHeat(show); } catch (e) {}
    }
  }

  var dragPause = false, dragTimer = 0;
  function bindDrag() {
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map || map.__windBound) return;
    map.__windBound = true;
    try {
      map.on('mapmove', function () {
        dragPause = true;
        clearTimeout(dragTimer);
        dragTimer = setTimeout(function () { dragPause = false; respawnAll(); }, 160);
      });
      map.on('zoomchange', function () {
        dragPause = true;
        clearTimeout(dragTimer);
        dragTimer = setTimeout(function () { dragPause = false; respawnAll(); }, 160);
      });
    } catch (e) {}
  }

  function show() {
    ensureCanvas();
    on = true;
    bindDrag();
    if (cv) cv.style.display = '';
    if (heatWas === null) heatWas = true;
    heat(false);
    if (!grid) {
      fetchGrid(function () {
        var prj = projector();
        if (prj && !parts.length) for (var i = 0; i < N; i++) parts.push(spawn({}, prj));
        respawnAll();
      });
    }
    var prj = projector();
    if (prj && !parts.length) for (var i = 0; i < N; i++) parts.push(spawn({}, prj));
    resize();
  }

  function hide() {
    on = false;
    if (cv) cv.style.display = 'none';
    heat(heatWas === null ? true : heatWas);
  }

  window.WindLayer = {
    debug: function () { return { parts: parts.length, on: on, paused: paused, err: window.__windErr || null }; },
    show: show, hide: hide,
    setVisible: function (b) { b ? show() : hide(); },
    isOn: function () { return on; },
    isSynthetic: function () { return synth; },
    respawn: respawnAll,
    gridInfo: function () { return grid ? (grid.lats.length + '×' + grid.lons.length) : '-'; }
  };
})();
