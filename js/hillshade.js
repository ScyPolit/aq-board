/* ============================================================================
   hillshade.js —— 全球地形晕渲（分带重投影，修掉错位）
   · 墨卡托纬度非线性 → 源图切 64 条纬带逐带贴，避免上下错层
   · 高程配色（深海/浅海/丘陵/山地/高原/雪线）× 坡度光照 → 彩色地形
   · 监听 mapmove / zoomchange，拖动中实时跟随；pitch>3 自动淡出
   ========================================================================== */
(function () {
  'use strict';

  var Z = 3;
  var NORTH = 78, SOUTH = -58;
  var BANDS = 64;
  var ready = false, loading = false;
  var cv, ctx, W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  var relief = null, meta = null;
  var on = true;

  function tileXY(lng, lat, z) {
    var n = Math.pow(2, z);
    var x = Math.floor((lng + 180) / 360 * n);
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    return [x, y];
  }

  /* 高程配色（半透明，直接当地形层用） */
  function colorOf(el, out) {
    var r, g, b, a;
    if (el < 0) { r = 0; g = 0; b = 0; a = 0; }
    else if (el < 200) { r = 10; g = 44; b = 78; a = 0.62; }
    else if (el < 800) { r = 8; g = 36; b = 66; a = 0.60; }
    else if (el < 2000) { r = 6; g = 28; b = 54; a = 0.58; }
    else if (el < 4000) { r = 5; g = 22; b = 46; a = 0.56; }
    else { r = 18; g = 40; b = 66; a = 0.50; }
    out[0] = r; out[1] = g; out[2] = b; out[3] = 1;
  }

  function load(cb) {
    if (ready) return cb(true);
    if (loading) return;
    loading = true;

    var tl = tileXY(-180, NORTH, Z), br = tileXY(180, SOUTH, Z);
    var x0 = tl[0], x1 = br[0], y0 = tl[1], y1 = br[1];
    var cols = x1 - x0 + 1, rows = y1 - y0 + 1;
    if (cols * rows > 90) {
      Z = 2; tl = tileXY(-180, NORTH, Z); br = tileXY(180, SOUTH, Z);
      x0 = tl[0]; x1 = br[0]; y0 = tl[1]; y1 = br[1]; cols = x1 - x0 + 1; rows = y1 - y0 + 1;
    }

    var SZ = 256;
    var big = document.createElement('canvas');
    big.width = cols * SZ; big.height = rows * SZ;
    var bctx = big.getContext('2d');

    var jobs = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        (function (cx, cy) {
          jobs.push(new Promise(function (res) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { bctx.drawImage(img, cx * SZ, cy * SZ); res(1); };
            img.onerror = function () { res(0); };
            img.src = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' + Z + '/' + (x0 + cx) + '/' + (y0 + cy) + '.png';
          }));
        })(c, r);
      }
    }

    Promise.all(jobs).then(function (okList) {
      if (okList.indexOf(1) < 0) { loading = false; return cb(false); }
      var data;
      try { data = bctx.getImageData(0, 0, big.width, big.height); }
      catch (e) { loading = false; return cb(false); }

      var GW = 512, GH = 340;
      var el = new Float32Array(GW * GH);
      var px = data.data;
      for (var gy = 0; gy < GH; gy++) {
        for (var gx = 0; gx < GW; gx++) {
          var sx = Math.floor(gx / GW * big.width);
          var sy = Math.floor(gy / GH * big.height);
          var i = (sy * big.width + sx) * 4;
          el[gy * GW + gx] = (px[i] * 256 + px[i + 1] + px[i + 2] / 256) - 32768;
        }
      }

      var out = document.createElement('canvas');
      out.width = GW; out.height = GH;
      var octx = out.getContext('2d');
      var img = octx.createImageData(GW, GH);
      var az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
      var lx = Math.cos(alt) * Math.sin(az), ly = Math.cos(alt) * Math.cos(az), lz = Math.sin(alt);
      var cell = 90;
      var c4 = [0, 0, 0, 0];

      for (var y = 0; y < GH; y++) {
        for (var x = 0; x < GW; x++) {
          var idx = y * GW + x;
          var e0 = el[idx];
          colorOf(e0, c4);

          var xm = Math.max(0, x - 1), xp = Math.min(GW - 1, x + 1);
          var ym = Math.max(0, y - 1), yp = Math.min(GH - 1, y + 1);
          var dzdx = (el[y * GW + xp] - el[y * GW + xm]) / (2 * cell);
          var dzdy = (el[yp * GW + x] - el[ym * GW + x]) / (2 * cell);
          var nx = -dzdx, ny = -dzdy, nz = 1;
          var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;
          var sv = nx * lx + ny * ly + nz * lz;
          sv = Math.max(0, Math.min(1, sv));
          var k = e0 > 5 ? (0.55 + sv * 0.95) : (0.9 + sv * 0.15);

          var o = idx * 4;
          img.data[o] = Math.max(0, Math.min(255, Math.round(c4[0] * k)));
          img.data[o + 1] = Math.max(0, Math.min(255, Math.round(c4[1] * k)));
          img.data[o + 2] = Math.max(0, Math.min(255, Math.round(c4[2] * k)));
          img.data[o + 3] = e0 > 5 ? 255 : 0;
        }
      }
      octx.putImageData(img, 0, 0);
      relief = out;

      var n = Math.pow(2, Z);
      meta = { x0: x0, y0: y0, cols: cols, rows: rows, Z: Z, n: n, GW: GW, GH: GH };
      ready = true; loading = false;
      cb(true);
    }).catch(function () { loading = false; cb(false); });
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
    if (!ctx || !ready || !on) return;
    ctx.clearRect(0, 0, W, H);
    var map = window.BaseMap.getMap();

    var pitch = map.getPitch ? map.getPitch() : 0;
    cv.style.opacity = pitch > 3 ? '0' : '0.75';
    if (pitch > 3) return;

    var prj = projector();
    if (!prj) return;

    var pl = prj(-180, 0), pr = prj(180, 0);
    if (!pl || !pr) return;
    var x0 = pl[0], x1 = pr[0];
    if (Math.abs(x1 - x0) > W * 1.5) return;   /* 跨 180° 不硬画 */

    var SH = relief.height, SW = relief.width;
    var bandH = SH / BANDS;
    var step = (NORTH - SOUTH) / BANDS;

    ctx.imageSmoothingEnabled = true;
    for (var i = 0; i < BANDS; i++) {
      var la0 = NORTH - step * i;
      var la1 = NORTH - step * (i + 1);
      var p0 = prj(0, la0), p1 = prj(0, la1);
      if (!p0 || !p1) continue;
      var y0 = p0[1], y1 = p1[1];
      if (Math.abs(y1 - y0) < 0.2) continue;
      ctx.drawImage(
        relief,
        0, Math.round(i * bandH), SW, Math.ceil(bandH) + 1,
        x0, y0, x1 - x0, y1 - y0
      );
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
    cv.className = 'hill-canvas terrain-canvas';
    host.appendChild(cv);
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
        setTimeout(draw, 500); setTimeout(draw, 1500); setTimeout(draw, 2600);
        return;
      }
      if (++tries < 40) setTimeout(hook, 400);
    })();
    return true;
  }

  window.HillShade = {
    init: init,
    redraw: draw,
    isReady: function () { return ready; },
    setVisible: function (b) { on = !!b; if (cv) cv.style.display = on ? '' : 'none'; if (on) draw(); }
  };
})();
