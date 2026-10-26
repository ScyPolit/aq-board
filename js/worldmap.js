/* ============================================================================
   worldmap.js —— 矢量世界地图（发光青色国界 + 点阵填充）
   用 ECharts 的世界 GeoJSON，自己按墨卡托投影画在 canvas 上，
   和风场用同一套投影，跟着高德地图的 center/zoom 同步。
   ========================================================================== */
(function () {
  'use strict';

  var GEO_URL = 'https://unpkg.com/echarts@4.9.0/map/json/world.json';
  var geo = null, loading = false, on = true;
  var cv, ctx, W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  var dotPattern = null;

  function merc(lng, lat) {
    var x = (lng + 180) / 360;
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  }

  /* 用高德自己的 lngLatToContainer 反推比例尺，保证和高德底图严格对齐 */
  function projector() {
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map || !map.lngLatToContainer) return null;
    var p0 = map.lngLatToContainer([0, 0]);
    var p1 = map.lngLatToContainer([90, 0]);
    var p2 = map.lngLatToContainer([0, 40]);
    if (!p0 || !p1 || !p2) return null;
    var x0 = p0.getX ? p0.getX() : p0.x, y0 = p0.getY ? p0.getY() : p0.y;
    var x1 = p1.getX ? p1.getX() : p1.x;
    var y2 = p2.getY ? p2.getY() : p2.y;

    var m0 = merc(0, 0), m1 = merc(90, 0), m2 = merc(0, 40);
    var sx = (x1 - x0) / (m1[0] - m0[0]);
    var sy = (y2 - y0) / (m2[1] - m0[1]);

    return function (lng, lat) {
      var m = merc(lng, lat);
      return [x0 + (m[0] - m0[0]) * sx, y0 + (m[1] - m0[1]) * sy];
    };
  }

  /* 点阵纹理 */
  function makePattern() {
    var p = document.createElement('canvas');
    p.width = 9; p.height = 9;
    var c = p.getContext('2d');
    c.fillStyle = 'rgba(140,230,255,0.42)';
    c.beginPath();
    c.arc(4.5, 4.5, 0.8, 0, Math.PI * 2);
    c.fill();
    return ctx.createPattern(p, 'repeat');
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

  function eachRing(feature, fn) {
    var g = feature.geometry;
    if (!g) return;
    if (g.type === 'Polygon') g.coordinates.forEach(fn);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (poly) { poly.forEach(fn); });
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!geo || !on) return;

    var map = window.BaseMap.getMap();
    var z = map ? map.getZoom() : 3;
    if (z > 5.6) return;                       /* 拉近到城市级就交给高德底图 */

    var prj = projector();
    if (!prj) return;
    if (!dotPattern) dotPattern = makePattern();

    ctx.lineJoin = 'round';

    geo.forEach(function (f) {
      ctx.beginPath();
      var drawn = false;
      eachRing(f, function (ring) {
        var started = false;
        for (var i = 0; i < ring.length; i++) {
          var p = prj(ring[i][0], ring[i][1]);
          if (p[0] < -2000 || p[0] > W + 2000) { started = false; continue; }
          if (!started) { ctx.moveTo(p[0], p[1]); started = true; drawn = true; }
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
      });
      if (!drawn) return;

      /* 填充：上深下浅的青色渐变 */
      var gd = ctx.createLinearGradient(0, 0, 0, H);
      gd.addColorStop(0, 'rgba(14,64,116,0.72)');
      gd.addColorStop(0.55, 'rgba(20,104,178,0.62)');
      gd.addColorStop(1, 'rgba(10,56,104,0.72)');
      ctx.fillStyle = gd;
      ctx.fill();
    });

    /* 点阵纹理层（再描一遍路径做裁剪填充） */
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = dotPattern;
    geo.forEach(function (f) {
      ctx.beginPath();
      var drawn = false;
      eachRing(f, function (ring) {
        var started = false;
        for (var i = 0; i < ring.length; i++) {
          var p = prj(ring[i][0], ring[i][1]);
          if (p[0] < -2000 || p[0] > W + 2000) { started = false; continue; }
          if (!started) { ctx.moveTo(p[0], p[1]); started = true; drawn = true; }
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
      });
      if (drawn) ctx.fill();
    });
    ctx.globalAlpha = 1;

    /* 发光国界 */
    ctx.shadowColor = 'rgba(60,210,255,0.95)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(90,225,255,0.95)';
    ctx.lineWidth = 0.9;

    geo.forEach(function (f) {
      ctx.beginPath();
      eachRing(f, function (ring) {
        var started = false;
        for (var i = 0; i < ring.length; i++) {
          var p = prj(ring[i][0], ring[i][1]);
          if (p[0] < -2000 || p[0] > W + 2000) { started = false; continue; }
          if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
      });
      ctx.stroke();
    });
    ctx.shadowBlur = 0;
  }

  function resize() {
    var host = document.getElementById('baseMap');
    if (!host || !cv) return;
    W = host.clientWidth; H = host.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function ensure() {
    if (cv) return;
    var host = document.getElementById('baseMap');
    if (!host) return;
    cv = document.createElement('canvas');
    cv.className = 'fx-canvas world-canvas';
    host.appendChild(cv);
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function init() {
    ensure();
    load(function () { draw(); });
    var tries = 0;
    (function hook() {
      var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
      if (map) {
        var redraw = function () { setTimeout(draw, 90); };
        try { map.on('moveend', redraw); map.on('zoomend', redraw); } catch (e) {}
        setTimeout(draw, 400);
        return;
      }
      if (++tries < 40) setTimeout(hook, 400);
    })();
    return true;
  }

  window.WorldMap = {
    init: init,
    redraw: draw,
    setVisible: function (b) { on = !!b; if (cv) cv.style.display = on ? '' : 'none'; if (on) draw(); },
    isLoaded: function () { return !!geo; }
  };
})();
