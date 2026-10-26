/* ============================================================================
   chinamap.js —— 主地图渲染（推翻重做）
   深蓝底 + 渐变蓝色省份 + 发光边界 + 省份名称 + 城市光点
   投影用 AMap 的 lngLatToContainer 反推，与世界地图/等高线严格对齐
   ========================================================================== */
(function () {
  'use strict';

  var GEO_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
  var geo = null, loading = false, on = true;
  var cv, ctx, W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  var MAX_Z = 6.2;                 /* 超过这个缩放就交给高德 */

  function merc(lng, lat) {
    var x = (lng + 180) / 360;
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  }

  /* 用高德在「中国范围内」的两个参考点反推比例尺（(0,0) 在视野外会返回空） */
  function projector() {
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map || !map.lngLatToContainer) return null;

    function px(lng, lat) {
      var p = map.lngLatToContainer([lng, lat]);
      if (!p) return null;
      return [p.getX ? p.getX() : p.x, p.getY ? p.getY() : p.y];
    }

    var a = px(100, 30), b = px(120, 30), c = px(100, 50);
    if (!a || !b || !c) return null;
    if (!isFinite(a[0]) || !isFinite(b[0]) || !isFinite(c[1])) return null;

    var ma = merc(100, 30), mb = merc(120, 30), mc = merc(100, 50);
    var sx = (b[0] - a[0]) / (mb[0] - ma[0]);
    var sy = (c[1] - a[1]) / (mc[1] - ma[1]);
    if (!isFinite(sx) || !isFinite(sy) || sx === 0 || sy === 0) return null;

    return function (lng, lat) {
      var m = merc(lng, lat);
      return [a[0] + (m[0] - ma[0]) * sx, a[1] + (m[1] - ma[1]) * sy];
    };
  }

  function load(cb) {
    if (geo) return cb();
    if (loading) return;
    loading = true;
    fetch(GEO_URL).then(function (r) { return r.json(); }).then(function (j) {
      geo = j.features || [];
      loading = false;
      cb();
    }).catch(function () { loading = false; });
  }

  function rings(feature) {
    var g = feature.geometry, out = [];
    if (!g) return out;
    if (g.type === 'Polygon') out.push(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (p) { out.push(p); });
    return out;
  }

  function pathOf(f, prj) {
    var path = new Path2D();
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    var polys = rings(f);
    polys.forEach(function (poly) {
      poly.forEach(function (ring) {
        var started = false;
        for (var i = 0; i < ring.length; i++) {
          var p = prj(ring[i][0], ring[i][1]);
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
          if (!started) { path.moveTo(p[0], p[1]); started = true; }
          else path.lineTo(p[0], p[1]);
        }
        path.closePath();
      });
    });
    return { path: path, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX };
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!on || !geo) return;

    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    var z = map ? map.getZoom() : 4;
    if (z > MAX_Z) {                   /* 城市级才显示高德 */
      var st2 = document.getElementById('stage');
      if (st2) st2.classList.remove('vector-map');
      return;
    }

    /* 只留一层：省级时把高德底图整个藏掉 */
    var st = document.getElementById('stage');
    if (st) st.classList.add('vector-map');

    var prj0 = projector();
    if (!prj0) return;

    /* 把「地图容器坐标」换成「画布坐标」 */
    var cont = map.getContainer().getBoundingClientRect();
    var cr = cv.getBoundingClientRect();
    var offX = cont.left - cr.left, offY = cont.top - cr.top;
    var scaleX = 1;   /* 画布与地图容器同为 CSS 像素，只差一个偏移 */
    var prj = function (lng, lat) {
      var q = prj0(lng, lat);
      return [q[0] + offX, q[1] + offY];
    };

    var data = (window.AQApp && window.AQApp.data()) || [];
    var byName = {};
    data.forEach(function (d) { byName[d.name] = d; });

    /* ① 省份填充 + 发光边界（逐省 path 内联绘制，已验证稳定） */
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#4a92f0');
    grad.addColorStop(0.45, '#2a6ad0');
    grad.addColorStop(1, '#17408f');

    function tracePath(f) {
      ctx.beginPath();
      var polys = rings(f);
      polys.forEach(function (poly) {
        poly.forEach(function (ring) {
          var started = false;
          for (var i = 0; i < ring.length; i++) {
            var p = prj(ring[i][0], ring[i][1]);
            if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
            else ctx.lineTo(p[0], p[1]);
          }
          ctx.closePath();
        });
      });
    }

    /* 填充 */
    ctx.fillStyle = grad;
    geo.forEach(function (f) { tracePath(f); ctx.fill(); });

    /* 边界发光 */
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(190,232,255,0.95)';
    ctx.lineWidth = 1.2;
    ctx.shadowColor = 'rgba(120,205,255,0.95)';
    ctx.shadowBlur = 9;
    geo.forEach(function (f) { tracePath(f); ctx.stroke(); });
    ctx.shadowBlur = 0;

    /* ② 省份名称 */
    ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    geo.forEach(function (f) {
      var nm = f.properties && (f.properties.name || f.properties.NAME);
      if (!nm) return;
      var info = pathOf(f, prj);
      if (!info.w || info.w < 4) return;
      if (info.cx < 0 || info.cx > W || info.cy < 0 || info.cy > H) return;
      ctx.fillStyle = 'rgba(2,18,40,.9)';
      ctx.fillText(nm, info.cx + 0.9, info.cy + 0.9);
      ctx.fillStyle = 'rgba(240,250,255,.95)';
      ctx.fillText(nm, info.cx, info.cy);
    });

    /* ③ 城市光点 */
    data.forEach(function (d) {
      if (!isFinite(d.lng) || !isFinite(d.lat)) return;
      var p = prj(d.lng, d.lat);
      if (p[0] < -40 || p[0] > W + 40 || p[1] < -40 || p[1] > H + 40) return;
      var lv = window.AQ.levelOf(d.aqi);
      var r = 3 + Math.min(5, d.aqi / 34);
      var g2 = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 2.6);
      g2.addColorStop(0, lv.color);
      g2.addColorStop(0.3, lv.color);
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(p[0], p[1], r * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = lv.color; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
    });
  }

  function resize() {
    var host = document.querySelector('.bg-layer');
    if (!host || !cv) return;
    W = host.clientWidth || host.offsetWidth;
    H = host.clientHeight || host.offsetHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function ensure() {
    if (cv) return;
    var host = document.querySelector('.bg-layer');
    if (!host) return;
    cv = document.createElement('canvas');
    cv.className = 'fx-canvas china-canvas';
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2';
    host.appendChild(cv);
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  /* 点击就近城市 → 下钻（画布不拦事件，监听挂在高德容器上） */
  function bindClick() {
    var host = document.querySelector('.bg-layer');
    if (!host || host.__chinaClick) return;
    host.__chinaClick = true;
    host.addEventListener('click', function (e) {
      var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
      if (!map) return;
      if (map.getZoom() > MAX_Z) return;          /* 城市级交给高德自己 */
      var rect = map.getContainer().getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var data = (window.AQApp && window.AQApp.data()) || [];
      var prj = projector();
      if (!prj) return;
      var best = null, bestD = 26;                 /* 26px 内算命中 */
      data.forEach(function (d) {
        var p = prj(d.lng, d.lat);
        var dist = Math.sqrt((p[0] - mx) * (p[0] - mx) + (p[1] - my) * (p[1] - my));
        if (dist < bestD) { bestD = dist; best = d; }
      });
      if (!best) return;
      try {
        document.dispatchEvent(new CustomEvent('drill:city', { detail: best.name }));
        window.AQApp && window.AQApp.select && window.AQApp.select(best.name, true);
      } catch (err) {}
    });
  }

  function init() {
    ensure();
    bindClick();
    load(function () { draw(); });
    var tries = 0;
    (function hook() {
      var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
      if (map) {
        /* 拖拽/缩放过程中连续重绘，避免"跳帧" */
        var raf = 0;
        var re = function () {
          if (raf) return;
          raf = requestAnimationFrame(function () { raf = 0; draw(); });
        };
        try {
          map.on('mapmove', re);
          map.on('zoomchange', re);
          map.on('moveend', re);
          map.on('zoomend', re);
        } catch (e) {}
        setTimeout(draw, 500);
        setTimeout(draw, 1500);
        setTimeout(draw, 2600);
        return;
      }
      if (++tries < 40) setTimeout(hook, 400);
    })();
    return true;
  }

  window.ChinaMap = {
    prjTest: function () {
      var prj = projector();
      if (!prj) return 'no prj';
      var out = { p116_40: prj(116, 40), p100_30: prj(100, 30) };
      if (geo && geo[0]) {
        var r = rings(geo[0])[0];
        out.type0 = geo[0].geometry.type;
        out.first = r && r[0] ? r[0].slice(0, 4) : null;
        if (out.first) out.firstProj = prj(out.first[0], out.first[1]).map(Math.round);
      }
      return out;
    },
    debug: function () {
      var prj = projector();
      var out = { geo: geo ? geo.length : 0, W: W, H: H, sample: null };
      if (prj && geo && geo[0]) {
        var r = rings(geo[0])[0] && rings(geo[0])[0][0];
        if (r && r[0]) out.sample = { name: geo[0].properties && geo[0].properties.name, p: prj(r[0][0], r[0][1]).map(Math.round) };
      }
      out.px = (function () {
        try {
          var c = cv.getContext('2d');
          var d = c.getImageData(0, 0, cv.width, cv.height).data;
          var n = 0;
          for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
          return n;
        } catch (e) { return -1; }
      })();
      return out;
    },
    init: init,
    redraw: draw,
    setVisible: function (b) { on = !!b; if (cv) cv.style.display = on ? '' : 'none'; if (on) draw(); },
    isLoaded: function () { return !!geo; }
  };
})();
