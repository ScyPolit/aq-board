/* ============================================================================
   drill.js —— 单视图连续下钻：全国 → 省 → 市 → 区县 → 3D 建筑
   地图只有一张（高德），所有层级都在这张图上进行：
     · 全国：城市点 + 流动光弧
     · 省：飞到该省，点/列表选市
     · 市：画出区县区块（本地缓存优先）
     · 继续放大（z ≥ 12.5）：自动切到 Three.js 3D 城市，能看到建筑体块高度
   左侧列表 + 右侧指标跟随层级刷新；顶部面包屑可逐级返回。
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.MAP_CONFIG || {};
  var $ = function (s) { return document.querySelector(s); };

  var P = { fillBase: 0.14 };

  var D = {
    level: 'province',           /* province | city | district */
    province: null, city: null,
    units: [], baseAqi: 70,
    mode3d: false, token: 0,
    map: null, polys: [], texts: [],
    lastZoomIn: false
  };

  /* ---------------- 工具 ---------------- */
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  function fakeAqi(base, name) {
    var f = 0.74 + (hash(name) % 1000) / 1000 * 0.54;
    return Math.max(12, Math.min(300, Math.round(base * f)));
  }
  function lvColor(aqi) { return window.AQ ? window.AQ.levelOf(aqi).color : '#56d8ff'; }
  function hint(msg) { var el = $('#cascHint'); if (el) el.innerHTML = msg || ''; }
  function cities() { return (window.AQApp && window.AQApp.data()) || []; }

  function districtData(name) {
    var a = (window.DISTRICTS && window.DISTRICTS[name]) || null;
    if (a && a.length >= 3) return a;
    var b = (window.MORE && window.MORE[name]) || null;
    if (b && b.length >= 3) return b;
    return null;
  }


  /* ---------- 三级边界获取：本地 → 在线(缓存24h) → 示意街区 ---------- */
  var LS_KEY = 'aq_districts_cache_v1';

  function lsGet() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function lsPut(name, units) {
    try {
      var all = lsGet();
      all[name] = { t: Date.now(), units: units };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  function lsFind(name) {
    var all = lsGet(), v = all[name];
    if (v && Date.now() - v.t < 24 * 3600 * 1000) return v.units;
    return null;
  }

  /* 退化：城市中心 8×8 规则街区 */
  function syntheticDistricts(city) {
    var out = [], N = 8, step = 0.055;
    var lat0 = (city.lat || 34) - N * step / 2;
    var lng0 = (city.lng || 113) - N * step / 2;
    for (var r = 0; r < N; r++) {
      for (var cIdx = 0; cIdx < N; cIdx++) {
        var la = lat0 + r * step, ln = lng0 + cIdx * step;
        var ring = [
          [ln, la], [ln + step * 0.86, la], [ln + step * 0.86, la + step * 0.86], [ln, la + step * 0.86]
        ];
        var flat = ring.map(function (p) { return p[0].toFixed(3) + ',' + p[1].toFixed(3); }).join(';');
        out.push({
          name: '街区 ' + String.fromCharCode(65 + r) + (cIdx + 1),
          kind: 'district',
          center: { lng: ln + step * 0.43, lat: la + step * 0.43 },
          boundaries: [flat]
        });
      }
    }
    return out;
  }


  /* ---------- 顶部三块重排：按钮行 / 标题并入列表头 / 指标进右列 ---------- */
  var _moved = { tabs: false, stats: false };

  function enterDrillLayout() {
    var bar = document.querySelector('.casc-bar');
    var tabs = document.querySelector('.map-stage .tabs');
    var stage = document.getElementById('stage');
    var stats = document.getElementById('cascStats');
    var rightCol = document.querySelector('.side-col:last-of-type');

    /* ① 污染物按钮 → casc-bar 第一行 */
    if (bar && tabs && !_moved.tabs) {
      bar.insertBefore(tabs, bar.firstChild);
      tabs.classList.add('in-bar');
      tabs.style.display = '';
      _moved.tabs = true;
    }

    /* ② 标题并入列表头，全页只留一处「省份一览」 */
    var title = document.getElementById('cascTitle');
    if (title) title.style.display = 'none';

    /* ③ 区域指标 → 右列，时钟正下方 */
    if (stats && rightCol && !_moved.stats) {
      rightCol.insertBefore(stats, rightCol.firstChild);
      stats.classList.add('in-side');
      _moved.stats = true;
    }
    if (stage) stage.classList.add('drill-layout');
  }

  function exitDrillLayout() {
    var tabs = document.querySelector('.casc-bar .tabs');
    var stage = document.querySelector('.map-stage');
    var view = document.getElementById('cascadeView');
    var stats = document.querySelector('.side-col .casc-stats');
    var title = document.getElementById('cascTitle');

    if (tabs && stage && _moved.tabs) {
      stage.insertBefore(tabs, view);
      tabs.classList.remove('in-bar');
      _moved.tabs = false;
    }
    if (stats && view && _moved.stats) {
      view.appendChild(stats);
      stats.classList.remove('in-side');
      _moved.stats = false;
    }
    if (title) title.style.display = '';
    var st = document.getElementById('stage');
    if (st) st.classList.remove('drill-layout');
  }

  /* ---------------- 面包屑 ---------------- */
  function renderPath() {
    var el = $('#drillPath');
    if (!el) return;
    var parts = ['<a data-lv="province">全国</a>'];
    if (D.province) parts.push('<a data-lv="city" data-p="' + D.province + '">' + D.province + '</a>');
    if (D.city) parts.push('<b>' + D.city + '</b>');
    el.innerHTML = parts.join('<i>›</i>');
    Array.prototype.forEach.call(el.querySelectorAll('a'), function (a) {
      a.addEventListener('click', function () {
        if (a.dataset.lv === 'province') goProvince();
        else if (a.dataset.lv === 'city') goProvince(a.dataset.p);
      });
    });
  }

  /* ---------------- 层级：省 ---------------- */
  function resetDrillLayout() {
    var tabs = document.querySelector('.casc-bar .tabs');
    var stage = document.querySelector('.map-stage');
    var view = document.getElementById('cascadeView');
    var stats = document.querySelector('.side-col .casc-stats');
    if (tabs && stage && view) { stage.insertBefore(tabs, view); tabs.classList.remove('in-bar'); }
    if (stats && view) { view.appendChild(stats); stats.classList.remove('in-side'); }
    var st = document.getElementById('stage');
    if (st) st.classList.remove('drill-layout');
    var title = document.getElementById('cascTitle');
    if (title) title.style.display = '';
  }

  function showUI() {
    var tabs = document.querySelector('.map-stage .tabs');
    if (tabs) tabs.style.display = '';
    var v = $('#cascadeView');
    if (v) { v.hidden = false; v.removeAttribute('hidden'); }
  }

  function goProvince(keep) {
    exit3D();
    showUI();
    var tabs0 = document.querySelector('.map-stage .tabs');
    if (tabs0) tabs0.style.display = '';
    D.level = 'province'; D.city = null;
    if (!keep) D.province = null;

    var by = {};
    cities().forEach(function (c) {
      var p = c.province || '其他';
      if (!by[p]) by[p] = { name: p, n: 0, sum: 0, lng: 0, lat: 0, worst: null };
      var g = by[p];
      g.n++; g.sum += c.aqi; g.lng += c.lng; g.lat += c.lat;
      if (!g.worst || c.aqi > g.worst.aqi) g.worst = c;
    });
    /* 补齐 34 个省级行政区（无数据的置灰显示） */
    var ALL34 = ['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏','浙江',
      '安徽','福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川','贵州',
      '云南','西藏','陕西','甘肃','青海','宁夏','新疆','台湾','香港','澳门'];
    ALL34.forEach(function (n) {
      if (!by[n]) by[n] = { name: n, n: 0, sum: 0, lng: 0, lat: 0, worst: null, empty: true };
      else by[n].empty = false;
    });

    D.units = Object.keys(by).map(function (k) {
      var g = by[k];
      return {
        name: g.name, kind: 'province', count: g.n,
        aqi: g.empty ? null : Math.round(g.sum / g.n),
        lng: g.lng / g.n, lat: g.lat / g.n, worst: g.worst
      };
    });

    renderPath();
    renderList();
    renderStats();
    hint('');
    clearMapOverlays();
    if (window.BaseMap && window.BaseMap.setMarkers) window.BaseMap.setMarkers(true);
    if (window.BaseMap && window.BaseMap.setFlows) window.BaseMap.setFlows(true);
    var t = $('#cascTitle'); if (t) t.textContent = '全国 · 省份一览';
    if (!keep) { fitNation(); setTimeout(fitNation, 400); setTimeout(fitNation, 1200); }
  }

  function fitNation() {
    var m = D.map || (window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap());
    if (!m) return;
    try { m.setZoomAndCenter(2.9, [104, 26], true); m.setPitch(0, true); } catch (e) {}
  }

  /* ---------------- 层级：该省下的市 ---------------- */
  function goCities(province) {
    exit3D();
    resetDrillLayout();
    showUI();
    D.level = 'city'; D.province = province; D.city = null;
    D.units = cities().filter(function (c) { return (c.province || '其他') === province; })
      .map(function (c) {
        return { name: c.name, kind: 'city', aqi: c.aqi, lng: c.lng, lat: c.lat, count: 0 };
      });
    renderPath();
    renderList();
    renderStats();
    var t = $('#cascTitle'); if (t) t.textContent = province + ' · 城市一览';
    clearMapOverlays();
    if (window.BaseMap && window.BaseMap.setMarkers) window.BaseMap.setMarkers(true);
    if (window.BaseMap && window.BaseMap.setFlows) window.BaseMap.setFlows(true);

    var m = D.map || (window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap());
    if (m && D.units.length) {
      var lng = 0, lat = 0;
      D.units.forEach(function (u) { lng += u.lng; lat += u.lat; });
      try { m.setZoomAndCenter(6.2, [lng / D.units.length, lat / D.units.length], true); } catch (e) {}
    }
  }

  /* ---------------- 层级：该市的区县 ---------------- */
  /* 用可解释模型给区县估值（替换原来的 name.hash 假数） */
  function estimateDistricts(city, units) {
    var est = (window.AQEstimate && window.AQEstimate.estimate(city, units)) || [];
    var byName = {};
    est.forEach(function (e) { byName[e.name] = e; });
    units.forEach(function (u) {
      var e2 = byName[u.name];
      u.aqi = e2 ? e2.aqi : Math.round(city.aqi || 60);
      u.base = u.aqi;
      u.source = 'estimated';
      u.factor = e2 ? e2.factor : 1;
    });
    return units;
  }

  function goCity(name) {
    exit3D();
    resetDrillLayout();
    showUI();
    var c = cities().filter(function (x) { return x.name === name; })[0];
    if (!c) return;
    D.level = 'district'; D.province = c.province; D.city = name;
    D.baseAqi = c.aqi || 70;

    /* 港澳台：优先用内置区域表（断网也有数据） */
    var hmt = window.REGIONS_HMT && window.REGIONS_HMT[c.province];
    if (hmt && hmt.length) {
      D.units = hmt.map(function (r) {
        return {
          name: r.name, kind: 'district',
          center: { lng: r.center.lng, lat: r.center.lat },
          boundaries: [],
          aqi: Math.round((r.baseAqi + (c.aqi - 45) * 0.6)),
          source: 'baseline'
        };
      });
      renderList(); renderStats();
      hint('数据来源：本地基准表（' + c.province + '）');
      var m0 = D.map;
      if (m0 && c.lng) { try { m0.setZoomAndCenter(9.5, [c.lng, c.lat], true); m0.setPitch(45, true); } catch (e) {} }
      return;
    }

    var local = districtData(name) || lsFind(name);
    D.source = local ? (districtData(name) ? 'local' : 'cache') : 'pending';
    renderPath();
    var t = $('#cascTitle'); if (t) t.textContent = name + ' · 区县一览';

    if (local) {
      D.units = local.map(function (u) {
        return { name: u.name, kind: 'district', center: u.center, boundaries: u.boundaries, aqi: D.baseAqi };
      });
      estimateDistricts(c, D.units);
      renderList(); renderStats(); drawDistricts();
      return;
    }

    /* 没有本地边界：实时查 */
    hint('正在加载 ' + name + ' 的区县…');
    childrenOf(name, 'city', function (list) {
      if (!list || !list.length) {
        /* 拿不到区县：退化成都市中心示意街区，保证 3D 依然可看 */
        D.units = syntheticDistricts(c);
        D.source = 'synthetic';
        estimateDistricts(c, D.units);
        renderList(); renderStats(); drawDistricts();
        hint('未取到『' + name + '』的行政边界，已用示意街区代替');
        return;
      }
      D.units = list.map(function (u) {
        return { name: u.name, kind: 'district', center: u.center, boundaries: [] };
      });
      estimateDistricts(c, D.units);
      renderList(); renderStats();
      /* 先飞到城市中心，边拉边界边画 */
      if (D.map && c.lng && c.lat) {
        try { D.map.setZoomAndCenter(9.5, [c.lng, c.lat], true); D.map.setPitch(45, true); } catch (e) {}
      }
      enrich(D.units, function () {
        hint('');
        D.source = 'online';
        lsPut(name, D.units.map(function (u) {
          return { name: u.name, center: u.center, boundaries: u.boundaries };
        }));
        drawDistricts();
      }, function () { drawDistricts(); });
    });
  }

  /* ---------------- 高德行政区查询（兜底） ---------------- */
  function childrenOf(name, level, cb) {
    if (!window.AMap) return cb([]);
    window.AMap.plugin('AMap.DistrictSearch', function () {
      try {
        var ds = new window.AMap.DistrictSearch({ level: level, subdistrict: 1, extensions: 'base' });
        ds.search(name, function (s, r) {
          if (s !== 'complete' || !r || !r.districtList || !r.districtList[0]) return cb([]);
          cb((r.districtList[0].districtList || []).map(function (c) {
            return { name: c.name, adcode: c.adcode, center: c.center, boundaries: [] };
          }));
        });
      } catch (e) { cb([]); }
    });
  }

  function boundaryOf(u, cb) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; cb([]); } }, 12000);
    window.AMap.plugin('AMap.DistrictSearch', function () {
      var ds = new window.AMap.DistrictSearch({ level: 'district', subdistrict: 0, extensions: 'all' });
      ds.search(String(u.adcode || u.name), function (s, r) {
        clearTimeout(timer);
        if (done) return; done = true;
        cb(s === 'complete' && r && r.districtList && r.districtList[0] ? (r.districtList[0].boundaries || []) : []);
      });
    });
  }

  function enrich(units, done, onEach) {
    var q = units.slice(0, 40), i = 0, active = 0, fin = 0, lastDraw = 0;
    if (!q.length) return done();
    (function next() {
      while (active < 8 && i < q.length) {
        var u = q[i++]; active++;
        (function (unit) {
          boundaryOf(unit, function (b) {
            active--; fin++;
            unit.boundaries = b;
            if (onEach && (fin - lastDraw >= 3)) { lastDraw = fin; try { onEach(); } catch (e) {} }
            if (fin === q.length) done();
            next();
          });
        })(u);
      }
    })();
  }

  /* ---------------- 地图区块 ---------------- */
  function parseRing(str) {
    if (!str) return [];
    var s = String(str).trim();
    if (s.indexOf(';') >= 0) {
      return s.split(';').map(function (p) { var a = p.split(','); return [parseFloat(a[0]), parseFloat(a[1])]; })
        .filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    }
    var flat = s.split(',').map(function (x) { return parseFloat(x); });
    var pts = [];
    for (var i = 0; i + 1 < flat.length; i += 2) {
      if (isFinite(flat[i]) && isFinite(flat[i + 1])) pts.push([flat[i], flat[i + 1]]);
    }
    return pts;
  }
  function ringsOf(u) {
    var out = [];
    (u.boundaries || []).forEach(function (b) {
      String(b).split('|').forEach(function (part) {
        var r = parseRing(part);
        if (r.length > 2) out.push(r);
      });
    });
    return out;
  }
  function rgba(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function shade(aqi, minA, maxA) {
    var base = lvColor(aqi).replace('#', '');
    if (base.length === 3) base = base[0] + base[0] + base[1] + base[1] + base[2] + base[2];
    var n = parseInt(base, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var span = Math.max(1, maxA - minA);
    var k = 0.55 + Math.max(0, Math.min(1, (aqi - minA) / span)) * 0.63;
    return 'rgba(' + Math.min(255, Math.round(r * k)) + ',' + Math.min(255, Math.round(g * k)) + ',' +
      Math.min(255, Math.round(b * k)) + ',0.62)';
  }

  function clearMapOverlays() {
    var m = D.map;
    if (!m) return;
    if (D.polys.length) m.remove(D.polys);
    if (D.texts.length) m.remove(D.texts);
    D.polys = []; D.texts = [];
  }

  function drawDistricts() {
    if (!D.map || !window.AMap) return;
    clearMapOverlays();
    if (window.BaseMap && window.BaseMap.setMarkers) window.BaseMap.setMarkers(false);
    if (window.BaseMap && window.BaseMap.setFlows) window.BaseMap.setFlows(false);

    var units = D.units.filter(function (u) { return ringsOf(u).length; });
    if (!units.length) { hint('没有拿到边界数据'); return; }

    var minA = 999, maxA = 1;
    units.forEach(function (u) { if (u.aqi < minA) minA = u.aqi; if (u.aqi > maxA) maxA = u.aqi; });

    var minLng = 999, maxLng = -999, minLat = 999, maxLat = -999;
    units.forEach(function (u) {
      var rings = ringsOf(u);
      var p = new window.AMap.Polygon({
        path: rings,
        strokeColor: 'rgba(180,242,255,.95)', strokeWeight: 1.2,
        fillColor: shade(u.aqi, minA, maxA), fillOpacity: 0.14,
        strokeOpacity: 0.9,
        bubble: true, zIndex: 30
      });
      p.setMap(D.map);
      D.polys.push(p);
      p.on('click', function () { hint('<b>' + u.name + '</b> · AQI ' + u.aqi); });
      p.on('mouseover', function () { p.setOptions({ fillOpacity: 0.28, strokeWeight: 2.2, strokeColor: '#ffffff' }); });
      p.on('mouseout', function () {
        p.setOptions({ fillOpacity: P.fillBase, strokeWeight: 1.2, strokeColor: 'rgba(180,242,255,.95)' });
      });

      rings.forEach(function (ring) {
        ring.forEach(function (pt) {
          if (pt[0] < minLng) minLng = pt[0];
          if (pt[0] > maxLng) maxLng = pt[0];
          if (pt[1] < minLat) minLat = pt[1];
          if (pt[1] > maxLat) maxLat = pt[1];
        });
      });

      if (u.center) {
        var tx = new window.AMap.Text({
          position: [u.center.lng, u.center.lat],
          text: '<span class="amap-tag">' + u.name + '</span>',
          anchor: 'center', bubble: true, style: { background: 'transparent', border: 'none' }
        });
        tx.setMap(D.map);
        D.texts.push(tx);
      }
    });

    if (minLng < 998) {
      var cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
      var span = Math.max(maxLng - minLng, (maxLat - minLat) * 1.25);
      var z = Math.log(1547 / Math.max(span, 0.05)) / Math.LN2;
      z = Math.max(6.5, Math.min(11.5, Math.round(z * 10) / 10));
      var apply = function () {
        try { D.map.setZoomAndCenter(z, [cx, cy], true); D.map.setPitch(45, true); } catch (e) {}
      };
      var tries = 0;
      apply();
      var iv = setInterval(function () { apply(); if (++tries > 8) clearInterval(iv); }, 160);
    }
    hint('');
  }

  /* ---------------- 列表 / 指标 ---------------- */
  function renderList() {
    var ul = $('#cascListUl');
    if (!ul) return;
    var units = D.units.slice().sort(function (a, b) {
      if (a.aqi == null && b.aqi == null) return 0;
      if (a.aqi == null) return 1;
      if (b.aqi == null) return -1;
      return b.aqi - a.aqi;
    });
    var maxA = 1; units.forEach(function (u) { if (u.aqi > maxA) maxA = u.aqi; });

    ul.innerHTML = units.map(function (u) {
      var noData = u.aqi == null;
      var c = noData ? 'rgba(150,170,185,.5)' : lvColor(u.aqi);
      return '<li data-name="' + u.name + '"' + (noData ? ' class="cl-nodata"' : '') + '>' +
        '<span class="cl-nm">' + u.name + (u.kind === 'province' ? ' <i class="cl-sub">' + (u.count || 0) + ' 市</i>' : '') + '</span>' +
        '<span class="cl-v" style="color:' + c + '">' + (noData ? '—' : u.aqi) + (u.source === 'estimated' ? '<em class="cl-est" title="按城市 AQI 推算，非实测">*</em>' : '') + '</span>' +
        '<span class="cl-bar"><i style="width:' + (noData ? 0 : u.aqi / maxA * 100) + '%;background:' + c + '"></i></span>' +
        '</li>';
    }).join('') || '<li class="cl-empty">暂无数据</li>';

    Array.prototype.forEach.call(ul.children, function (li) {
      if (!li.dataset.name) return;
      li.addEventListener('click', function () {
        var u = D.units.filter(function (x) { return x.name === li.dataset.name; })[0];
        if (!u) return;
        if (u.kind === 'province') goCities(u.name);
        else if (u.kind === 'city') goCity(u.name);
        else hint('<b>' + u.name + '</b> · AQI ' + u.aqi);
      });
    });

    var title = $('#cascListTitle');
    if (title) title.textContent = D.level === 'province' ? '省份一览' : (D.level === 'city' ? '城市一览' : '区县一览');
    var cnt = $('#cascListCount');
    if (cnt) cnt.textContent = D.units.length + ' 个';
  }

  function renderStats() {
    var units = D.units;
    var grid = $('#csGrid');
    if (!grid) return;
    if (!units.length) { grid.innerHTML = '<div class="cs-empty">暂无数据</div>'; return; }
    var total = 0, worst = null, best = null, nValid = 0;
    units.forEach(function (u) {
      if (u.aqi == null) return;
      total += u.aqi; nValid++;
      if (!worst || u.aqi > worst.aqi) worst = u;
      if (!best || u.aqi < best.aqi) best = u;
    });
    var avg = nValid ? Math.round(total / nValid) : null;
    worst = worst || { name: '—', aqi: '—' };
    best = best || { name: '—', aqi: '—' };
    var lvl = D.level === 'province' ? '省份' : (D.level === 'city' ? '城市' : '区县');
    grid.innerHTML = [
      ['单位数', units.length, lvl],
      ['平均 AQI', avg == null ? '—' : avg, avg == null ? '无数据' : (window.AQ ? window.AQ.levelOf(avg).label : '')],
      ['污染最重', worst.aqi, worst.name],
      ['最清洁', best.aqi, best.name]
    ].map(function (r) {
      return '<div class="cs-cell"><span class="cs-k">' + r[0] + '</span>' +
        '<span class="cs-v">' + r[1] + '</span>' +
        '<span class="cs-s">' + r[2] + '</span></div>';
    }).join('');
    if (D.level === 'district' && nValid) {
      var mn = Math.min.apply(null, units.filter(function (u) { return u.aqi != null; }).map(function (u) { return u.aqi; }));
      var mx = Math.max.apply(null, units.filter(function (u) { return u.aqi != null; }).map(function (u) { return u.aqi; }));
      var lv = $('#csRange');
      if (!lv) {
        lv = document.createElement('div');
        lv.id = 'csRange';
        lv.className = 'cs-range';
        grid.parentNode.insertBefore(lv, grid.nextSibling);
      }
      lv.textContent = '全市 ' + (D.baseAqi || '—') + ' · 区县 ' + mn + '~' + mx + '（推算值）';
    }

    var note = $('#csNote');
    if (note) {
      note.innerHTML = D.level === 'province'
        ? '点省份进入城市；再点城市看区县。地图放大到街区会自动进 3D。'
        : (D.level === 'city'
          ? '点城市看区县区块；继续放大会切到 3D 建筑模型。'
          : '底色按 AQI 分级；继续放大自动进入 3D 城市，能看到楼体高度。');
    }
  }

  /* ---------------- 3D ---------------- */
  function enter3D() {
    if (D.mode3d || !D.city) return;
    if (D.level !== 'district' && D.level !== 'city') return;
    var units = D.units.filter(function (u) { return ringsOf(u).length; });
    if (units.length < 3 || !window.City3D) return;

    D.mode3d = true;
    $('#stage').classList.add('city3d-on');
    P.fillBase = 0.05;
    D.polys.forEach(function (x) { x.setOptions({ fillOpacity: 0.05, strokeOpacity: 0.35 }); });
    var info = $('#city3dInfo');
    if (info) {
      var srcTxt = D.source === 'synthetic' ? '示意模型' : (D.source === 'online' ? '在线边界' : '本地边界');
      info.innerHTML = '<b>' + D.city + '</b><i>·</i>' + units.length + ' 个区块<i>·</i>' +
        srcTxt + (D.source === 'synthetic' ? '（未获取行政边界）' : '') +
        '<i>·</i>建筑高度按 AQI 推算';
    }
    var el = $('#city3d');
    if (!window.City3D.state.scene) window.City3D.init(el);
    window.City3D.resize();
    window.City3D.setData(units, { focus: true });
    window.City3D.resume();
    hint('3D 城市 · 滚轮继续放大看楼体，点区块看面积/高度');
    var t = $('#cascTitle'); if (t) t.textContent = D.city + ' · 3D 城市';
  }

  function exit3D() {
    if (!D.mode3d) return;
    D.mode3d = false;
    $('#stage').classList.remove('city3d-on');
    P.fillBase = 0.14;
    D.polys.forEach(function (x) { x.setOptions({ fillOpacity: 0.14, strokeOpacity: 0.9 }); });
    var info2 = $('#city3dInfo');
    if (info2) info2.innerHTML = '';
    if (window.City3D && window.City3D.pause) window.City3D.pause();
    var t = $('#cascTitle'); if (t) t.textContent = (D.city || D.province || '全国') + ' · 区县一览';
  }

  /* ---------------- 启动 ---------------- */
  function bind() {
    var m = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    D.map = m;
    if (!m) { setTimeout(bind, 400); return; }

    m.on('zoomend', function () {
      var z = m.getZoom();
      if (window.__aqFlying) return;           /* 飞行途中不许自动切 3D，避免抖一下 */
      /* 3D 城市已关闭自动进入 */
      else if (D.mode3d && z < 10.8) { exit3D(); }
    });

    $('#cascUp').addEventListener('click', function () {
      if (D.mode3d) { exit3D(); return; }
      if (D.level === 'district') goCities(D.province);
      else if (D.level === 'city') goProvince();
      else goProvince();
    });

    /* 搜索联动：搜到城市直接下钻 */
    document.addEventListener('drill:city', function (e) { if (e.detail) goCity(e.detail); });

    goProvince();
  }

  /* 订阅全局心跳：下钻列表与指标跟着轻微跳动，别像张死图 */
  document.addEventListener('aq:tick', function () {
    if (D.level !== 'district' || !D.units.length) return;
    D.units.forEach(function (u) {
      if (u.base == null) u.base = u.aqi;
      var k = 1 + (Math.random() - 0.5) * 0.08;      /* ±4% */
      u.aqi = Math.max(8, Math.round(u.base * k));
    });
    renderList();
    renderStats();
  });

  window.Cascade = {
    setMode: function (mode) {
      if (mode === 'cascade') { /* 兼容旧接口 */ }
      if (mode === 'nation') goProvince();
      if (mode === 'city3d') enter3D();
    },
    bind: bind,
    resize: function () { if (window.City3D && D.mode3d) window.City3D.resize(); },
    goCity: goCity,
    state: D
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(bind, 600); });
  else setTimeout(bind, 600);
})();
