/* ============================================================================
   dem.js —— 真实地形等高线（DEM）
   数据：AWS Terrain Tiles（terrarium 编码，公开无需 Key，支持 CORS）
         elevation = (R*256 + G + B/256) - 32768
   做法：拉 z=4 的若干瓦片拼成一张大图 → 降采样成网格 → marching squares 出等值线
        → 每次地图移动用墨卡托投影重画
   ========================================================================== */
(function () {
  'use strict';

  var Z = 4;
  var BBOX = { w: 70, e: 140, s: 12, n: 56 };
  var MINOR = 200, MAJOR = 1000;
  var LEVELS = [];                       /* 200m 细线 + 1000m 计曲线 */
  for (var _l = 0; _l <= 6000; _l += MINOR) LEVELS.push(_l);
  var ready = false, loading = false;
  var DEM_GRID = null, DEM_META = null;   /* 高程网格 + 经纬度换算用参数 */
  var segs = null;                    /* [{lv, pts:[[lng,lat],...]}] */
  var cv, ctx, W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  var on = false;

  function tileXY(lng, lat, z) {
    var n = Math.pow(2, z);
    var x = Math.floor((lng + 180) / 360 * n);
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    return [x, y];
  }

  function merc(lng, lat) {
    var x = (lng + 180) / 360;
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  }

  function load(cb) {
    if (ready) return cb();
    if (loading) return;
    loading = true;

    var tl = tileXY(BBOX.w, BBOX.n, Z), br = tileXY(BBOX.e, BBOX.s, Z);
    var x0 = tl[0], x1 = br[0], y0 = tl[1], y1 = br[1];
    var cols = x1 - x0 + 1, rows = y1 - y0 + 1;
    if (cols * rows > 60) {                           /* 保险：别拉太多 */
      Z = 3; tl = tileXY(BBOX.w, BBOX.n, Z); br = tileXY(BBOX.e, BBOX.s, Z);
      x0 = tl[0]; x1 = br[0]; y0 = tl[1]; y1 = br[1];
      cols = x1 - x0 + 1; rows = y1 - y0 + 1;
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
            img.onload = function () { bctx.drawImage(img, cx * SZ, cy * SZ); res(true); };
            img.onerror = function () { res(false); };
            img.src = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' + Z + '/' + (x0 + cx) + '/' + (y0 + cy) + '.png';
          }));
        })(c, r);
      }
    }

    Promise.all(jobs).then(function () {
      var data;
      try { data = bctx.getImageData(0, 0, big.width, big.height); }
      catch (e) { loading = false; return cb(false); }

      /* 降采样网格 */
      var GW = 320, GH = 220;
      var grid = new Float32Array(GW * GH);
      var px = data.data;
      for (var gy = 0; gy < GH; gy++) {
        for (var gx = 0; gx < GW; gx++) {
          var sx = Math.floor(gx / GW * big.width);
          var sy = Math.floor(gy / GH * big.height);
          var i = (sy * big.width + sx) * 4;
          var el = (px[i] * 256 + px[i + 1] + px[i + 2] / 256) - 32768;
          grid[gy * GW + gx] = el;
        }
      }

      DEM_GRID = grid;
      DEM_META = { x0: x0, y0: y0, cols: cols, rows: rows, GW: GW, GH: GH, Z: Z };

      /* 网格经纬度换算 */
      function gridToLngLat(gx, gy) {
        var n = Math.pow(2, Z);
        var wx = (x0 + (gx / (GW - 1)) * cols) / n;
        var wy = (y0 + (gy / (GH - 1)) * rows) / n;
        var lng = wx * 360 - 180;
        var nn = Math.PI - 2 * Math.PI * wy;
        var lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(nn) - Math.exp(-nn)));
        return [lng, lat];
      }

      /* marching squares */
      segs = [];
      LEVELS.forEach(function (lv) {
        var pts = [];
        for (var r2 = 0; r2 < GH - 1; r2++) {
          for (var c2 = 0; c2 < GW - 1; c2++) {
            var i0 = r2 * GW + c2, i1 = i0 + 1, i2 = i0 + GW, i3 = i2 + 1;
            var v0 = grid[i0], v1 = grid[i1], v2 = grid[i2], v3 = grid[i3];
            if (v0 > lv && v1 > lv && v2 > lv && v3 > lv) continue;
            if (v0 < lv && v1 < lv && v2 < lv && v3 < lv) continue;
            function L(a, b) { return grid[a] + (grid[b] - grid[a]) * 0; }
            var cross = [];
            function lerp(a, b) {
              var t = (lv - grid[a]) / ((grid[b] - grid[a]) || 1e-6);
              var ax = a % GW, ay = (a / GW) | 0, bx = b % GW, by = (b / GW) | 0;
              var gx = ax + (bx - ax) * t, gy = ay + (by - ay) * t;
              return gridToLngLat(gx, gy);
            }
            if ((v0 < lv) !== (v1 < lv)) cross.push(lerp(i0, i1));
            if ((v1 < lv) !== (v3 < lv)) cross.push(lerp(i1, i3));
            if ((v2 < lv) !== (v3 < lv)) cross.push(lerp(i2, i3));
            if ((v0 < lv) !== (v2 < lv)) cross.push(lerp(i0, i2));
            if (cross.length >= 2) pts.push([cross[0], cross[1]]);
          }
        }
        if (pts.length) segs.push({ lv: lv, pts: pts });
      });

      ready = true; loading = false;
      cb(true);
    }).catch(function () { loading = false; cb(false); });
  }

  function project() {
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!map) return null;
    var c = map.getCenter(), z = map.getZoom();
    var scale = 256 * Math.pow(2, z);
    var wc = merc(c.getLng(), c.getLat());
    return function (lng, lat) {
      var w = merc(lng, lat);
      return [(w[0] - wc[0]) * scale + W / 2, (w[1] - wc[1]) * scale + H / 2];
    };
  }

  function isMajor(lv) { return lv % MAJOR === 0; }

  function draw() {
    if (!ctx || !segs) return;
    ctx.clearRect(0, 0, W, H);
    var prj = project();
    if (!prj) return;

    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    var z = map ? map.getZoom() : 5;
    if (z < 3.4) return;                     /* 只有极远才隐藏 */
    var onlyMajor = z > 13;                  /* 太近只留计曲线 */

    var idx = 0;
    segs.forEach(function (s) {
      var major = isMajor(s.lv);
      if (onlyMajor && !major) return;
      idx++;

      ctx.beginPath();
      ctx.shadowColor = 'rgba(70,200,255,.85)';
      ctx.shadowBlur = major ? 7 : 4;
      ctx.lineWidth = major ? 1.0 : 0.6;
      ctx.strokeStyle = major ? 'rgba(170,250,255,.85)' : 'rgba(120,225,255,.50)';

      var pts = s.pts, drawn = 0;
      for (var i = 0; i < pts.length; i++) {
        var seg = pts[i];
        var p0 = prj(seg[0][0], seg[0][1]);
        var p1 = prj(seg[1][0], seg[1][1]);
        if (p0[0] < -600 && p1[0] < -600) continue;
        if (p0[0] > W + 600 && p1[0] > W + 600) continue;
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        drawn++;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      /* 每 12 条线放一个高程标签 */
      if (major && idx % 12 === 0 && drawn > 40) {
        var pick = pts[Math.floor(pts.length / 2)];
        var pp = prj(pick[0][0], pick[0][1]);
        if (pp[0] > 40 && pp[0] < W - 40 && pp[1] > 20 && pp[1] < H - 20) {
          var txt = s.lv + 'm';
          ctx.font = '9px monospace';
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(2,14,26,.8)';
          ctx.strokeText(txt, pp[0] + 4, pp[1] - 3);
          ctx.fillStyle = 'rgba(200,245,255,.85)';
          ctx.fillText(txt, pp[0] + 4, pp[1] - 3);
          ctx.lineWidth = 1;
        }
      }
    });
  }

  function ensure() {
    if (cv) return;
    var host = document.querySelector('.map-stage');
    if (!host) return;
    cv = document.createElement('canvas');
    cv.className = 'fx-canvas dem-canvas';
    host.appendChild(cv);
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    var host = document.querySelector('.map-stage');
    if (!host || !cv) return;
    W = host.clientWidth; H = host.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (on) draw();
  }

  function setVisible(b) {
    on = !!b;
    ensure();
    if (!cv) return;
    cv.style.display = on ? '' : 'none';
    if (!on) return;
    if (!ready) {
      var tag = document.getElementById('layerTag');
      if (tag) tag.textContent = '地形等高线 · 加载中…';
      load(function (ok) {
        if (!ok && tag) tag.textContent = '地形数据加载失败';
        if (ok && tag) tag.textContent = '地形等高线 · ' + Z + ' 级瓦片';
        draw();
      });
    } else draw();
  }

  /* 海陆判断：terrarium 海面高程为 0，>5m 视为陆地 */
  function isLand(lng, lat) {
    if (!DEM_GRID || !DEM_META) return true;
    var m = DEM_META, n = Math.pow(2, m.Z);
    var s2 = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    var wy = 0.5 - Math.log((1 + s2) / (1 - s2)) / (4 * Math.PI);
    var wx = (lng + 180) / 360;
    var cx = (wx * n - m.x0) / m.cols * (m.GW - 1);
    var cy = (wy * n - m.y0) / m.rows * (m.GH - 1);
    if (cx < 0 || cy < 0 || cx >= m.GW || cy >= m.GH) return true;
    return DEM_GRID[(cy | 0) * m.GW + (cx | 0)] > 5;
  }

  window.DEM = {
    isLand: isLand,
    debug: function () {
      var prj = project();
      var out = { levels: segs ? segs.length : 0, W: W, H: H, pts: 0, sample: null, onScreen: 0 };
      if (segs && prj) {
        segs.forEach(function (s) { out.pts += s.pts.length; });
        var f = segs[0] && segs[0].pts[0];
        if (f) {
          out.sample = [f[0][0].toFixed(2), f[0][1].toFixed(2)];
          var pp = prj(f[0][0], f[0][1]);
          out.proj = [Math.round(pp[0]), Math.round(pp[1])];
        }
        var n = 0;
        segs.forEach(function (s) {
          for (var i = 0; i < s.pts.length; i += 20) {
            var q = prj(s.pts[i][0][0], s.pts[i][0][1]);
            if (q[0] > -50 && q[0] < W + 50 && q[1] > -50 && q[1] < H + 50) n++;
          }
        });
        out.onScreen = n;
      }
      return out;
    },
    setVisible: setVisible,
    redraw: function () { if (on) draw(); },
    isOn: function () { return on; },
    isReady: function () { return ready; }
  };
})();
