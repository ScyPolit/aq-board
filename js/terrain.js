/* ============================================================================
   terrain.js —— 自定义地形瓦片层（canvas 逐张绘制，完全可控）
   · 用 AMap 的 lngLatToContainer 反推投影，瓦片按经纬度对齐
   · 只读本地 assets/terrain/{z}/{x}/{y}.png（离线、不闪、不 404）
   · 染色已经烘焙进 PNG，这里只用 CSS 的 soft-light + opacity 与底图融合
   ========================================================================== */
(function () {
  'use strict';

  var ZMIN = 3, ZMAX = 8;
  /* 本地覆盖范围：z<=4 全球；z 5~8 中国 bbox */
  var CN = { w: 73, e: 135, s: 18, n: 54 };

  var cv, ctx, W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  var cache = {};                 /* "z/x/y" -> Image 或 'fail' */
  var raf = 0, on = true;

  function tileXY(lng, lat, z) {
    var n = Math.pow(2, z);
    var x = (lng + 180) / 360 * n;
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    return [x, y];
  }

  function covered(z, x, y) {
    if (z <= 4) return true;
    var n = Math.pow(2, z);
    var x0 = Math.floor((CN.w + 180) / 360 * n), x1 = Math.floor((CN.e + 180) / 360 * n);
    var y0 = Math.floor(tileXY(0, CN.n, z)[1]), y1 = Math.floor(tileXY(0, CN.s, z)[1]);
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  function getImg(z, x, y) {
    var k = z + '/' + x + '/' + y;
    if (cache[k]) return cache[k];
    var img = new Image();
    img.src = 'assets/terrain/' + k + '.png';
    cache[k] = img;
    img.onload = function () { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; draw(); }); };
    img.onerror = function () { cache[k] = 'fail'; };
    return img;
  }

  function projector() {
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map) return null;
    var cont = map.getContainer().getBoundingClientRect();
    var cr = cv.getBoundingClientRect();
    var offX = cont.left - cr.left, offY = cont.top - cr.top;
    return function (lng, lat) {
      var p = map.lngLatToContainer([lng, lat]);
      if (!p) return null;
      return [(p.getX ? p.getX() : p.x) + offX, (p.getY ? p.getY() : p.y) + offY];
    };
  }

  function draw() {
    if (!ctx || !on) return;
    ctx.clearRect(0, 0, W, H);
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map) return;

    var zf = map.getZoom();
    var z = Math.max(ZMIN, Math.min(ZMAX, Math.round(zf)));
    var prj = projector();
    if (!prj) return;

    /* 视口对应的经纬度范围（多取一圈，避免边缘割裂） */
    var b = map.getBounds();
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    var tl = tileXY(sw.getLng(), ne.getLat(), z);
    var br = tileXY(ne.getLng(), sw.getLat(), z);
    var x0 = Math.floor(tl[0]) - 1, x1 = Math.floor(br[0]) + 1;
    var y0 = Math.floor(tl[1]) - 1, y1 = Math.floor(br[1]) + 1;

    var n = Math.pow(2, z);
    var size = 256;

    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        var xx = ((x % n) + n) % n;
        if (!covered(z, xx, y)) continue;

        var lng0 = xx / n * 360 - 180;
        var lng1 = (xx + 1) / n * 360 - 180;
        function latOf(yy) {
          var t = Math.PI - 2 * Math.PI * yy / n;
          return 180 / Math.PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
        }
        var lat0 = latOf(y), lat1 = latOf(y + 1);

        var p0 = prj(lng0, lat0), p1 = prj(lng1, lat1);
        if (!p0 || !p1) continue;
        var w = p1[0] - p0[0], h = p1[1] - p0[1];
        if (w <= 0.5 || h <= 0.5) continue;
        if (p0[0] > W || p1[0] < 0 || p0[1] > H || p1[1] < 0) continue;

        var img = getImg(z, xx, y);
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, p0[0], p0[1], w + 1, h + 1);
        }
      }
    }
  }

  function resize() {
    var host = document.querySelector('.bg-layer');
    if (!host || !cv) return;
    W = host.clientWidth; H = host.clientHeight;
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
    cv.className = 'terrain-canvas';
    host.appendChild(cv);
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function init() {
    ensure();
    var tries = 0;
    (function hook() {
      var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
      if (map) {
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
        setTimeout(draw, 400);
        setTimeout(draw, 1200);
        return;
      }
      if (++tries < 40) setTimeout(hook, 400);
    })();
    return true;
  }

  window.TerrainLayer = {
    init: init,
    redraw: draw,
    setVisible: function (b) {
      on = !!b;
      if (cv) cv.style.display = on ? '' : 'none';
      if (on) draw();
    },
    stats: function () {
      var n = 0, ok = 0;
      for (var k in cache) { n++; if (cache[k] && cache[k].naturalWidth) ok++; }
      return { tiles: n, loaded: ok, W: W, H: H };
    }
  };
})();
