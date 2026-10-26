/* ============================================================================
   底图切换：内置矢量 / 高德 AMap / 百度 BMapGL
   - 无 Key 时点击会给出提示，不影响矢量地图
   - 数据坐标是 WGS84，高德需转 GCJ-02，百度再转 BD-09
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.MAP_CONFIG || {};
  var state = { provider: cfg.provider || 'vector', map: null, sdk: null, overlays: [], markers: [], heat: [], ready: false };

  var PI = 3.14159265358979324, A = 6378245.0, EE = 0.00669342162296594323;

  /* ---------- 坐标转换 WGS84 -> GCJ02 -> BD09 ---------- */
  function outOfChina(lng, lat) { return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55); }
  function tLat(x, y) {
    var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
    return r;
  }
  function tLng(x, y) {
    var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
    return r;
  }
  function wgs2gcj(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
    var radLat = lat / 180 * PI, magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }
  function gcj2bd(lng, lat) {
    var z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * PI);
    var t = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * PI);
    return [z * Math.cos(t) + 0.0065, z * Math.sin(t) + 0.006];
  }
  function toGCJ(d) { return wgs2gcj(d.lng, d.lat); }
  function toBD(d) { var g = toGCJ(d); return gcj2bd(g[0], g[1]); }

  /* ---------- 工具 ---------- */
  function toast(msg) {
    var box = document.querySelector('.map-stage');
    if (!box) return;
    var t = document.createElement('div');
    t.className = 'map-toast';
    t.innerHTML = msg;
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 3200);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3800);
  }

  function loadScript(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = onload;
    s.onerror = function () { onerror && onerror(new Error('脚本加载失败')); };
    document.head.appendChild(s);
    return s;
  }

  /* ---------- 高德 ---------- */
  function initAMap() {
    if (!cfg.amapKey) { toast('未配置高德 Key：打开 <b>js/config.js</b> 填入 amapKey 后刷新。'); return false; }
    if (cfg.amapSecurity) {
      window._AMapSecurityConfig = { securityJsCode: cfg.amapSecurity };
    }
    var url = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cfg.amapKey);
    loadScript(url, function () { buildAMap(); }, function (e) {
      /* SDK 挂了就把底图让回矢量地图，别留一块黑色空壳挡住交互 */
      fallbackToVector('高德地图加载失败（' + (e && e.message || '网络异常') + '），已切回矢量底图。');
    });
    return true;
  }

  /** 高德/百度不可用时退回矢量地图：撤掉 on-basemap，让 ECharts 图层重新可见可交互 */
  function fallbackToVector(msg) {
    state.provider = 'vector';
    var stage = document.querySelector('.map-stage');
    if (stage) stage.classList.remove('on-basemap');
    var bg = document.getElementById('bgLayer');
    if (bg) bg.classList.remove('on-basemap');
    setLabel('VECTOR');
    if (msg) toast(msg);
  }

  function buildAMap() {
    var host = document.getElementById('baseMap');
    try {
      var map = new window.AMap.Map(host, {
        zoom: 2.6,
        center: [96, 26],
        viewMode: '3D',          /* 3D 模式：放大到街区会有楼块立体感 */
        pitch: 0,
        rotateEnable: true,
        pitchEnable: false,
        showBuildingBlock: true,   /* 城市级浅色样式下就是灰白 3D 楼块 */
        zooms: [3, 17],          /* 超过 16 级高德无数据，会出现灰底 English 水印 */
        /* 交互：滚轮缩放 / 拖拽 / 双击放大 —— 显式写出来，别依赖默认值 */
        scrollWheel: true,
        dragEnable: true,
        zoomEnable: true,
        doubleClickZoom: true,
        keyboardEnable: true,
        mapStyle: cfg.amapStyle || 'amap://styles/blue',
        skyColor: '#0b1a2e',
        resizeEnable: true,
        features: ['bg', 'road', 'building', 'point']
      });
      state.map = map; state.sdk = 'amap';

      /* ---------- 地形层：Esri 灰阶浮雕（在线瓦片），tileMaxZoom 兜底 ---------- */
      try {
        var terrain = new AMap.TileLayer({
          zIndex: 5,
          opacity: 0.55,
          tileMaxZoom: 13,
          getTileUrl: function (x, y, z) {
            return 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
                   'World_Shaded_Relief/MapServer/tile/' + z + '/' + y + '/' + x;
          }
        });
        map.add(terrain);
        /* 城市级隐藏地形层：放大后它又糊又抢戏 */
        map.on('zoomend', function () {
          var zz = map.getZoom();
          try { if (zz >= 11) terrain.hide(); else terrain.show(); } catch (e) {}

          /* 放大后自动收起风场：城市级没意义，还拖慢帧率 */
          try {
            if (window.WindLayer) {
              if (zz >= 9) {
                if (window.WindLayer.isOn()) { window.__windWanted = true; window.WindLayer.hide(); }
              } else if (window.__windWanted) {
                window.WindLayer.show();
              }
            }
          } catch (e) {}
        });
      } catch (e) { console.warn('terrain layer', e); }

      /* 卫星底图（Windy 式）：按需叠加/移除 */
      var satLayer = null;
      window.__setSatellite = function (on) {
        try {
          if (on && !satLayer && window.AMap.TileLayer.Satellite) {
            satLayer = new window.AMap.TileLayer.Satellite({ zIndex: 2, opacity: 1 });
            map.add(satLayer);
            map.setMapStyle('amap://styles/normal');
          } else if (!on && satLayer) {
            map.remove(satLayer); satLayer = null;
            map.setMapStyle(cfg.amapStyle || 'amap://styles/blue');
          }
        } catch (e) { console.warn('satellite', e); }
      };
      map.on('complete', function () { renderAMap(lastPayload); });
      renderAMap(lastPayload);

      /* 放大到街道级别自动抬头，出现 3D 楼块；拉远再压平 */
      map.on('zoomend', function () {
        /* 省级用反相极夜蓝，城市级还原（3D 楼块/道路才正常） */
        var st = document.getElementById('stage');
        var cityLevel = map.getZoom() >= 10;
        st && st.classList.toggle('city-zoom', cityLevel);
        /* 城市级换成浅色底图（街道清晰），省级保持极夜蓝 */
        try {
          if (cityLevel && !map.__cityStyle) { map.setMapStyle('amap://styles/normal'); map.__cityStyle = true; }
          else if (!cityLevel && map.__cityStyle) { map.setMapStyle('amap://styles/darkblue'); map.__cityStyle = false; }
        } catch (e) {}
        if (window.__aqTilt === false) { try { map.setPitch(0, true); } catch (e) {} return; }
        var z = map.getZoom();
        var want = z >= 15 ? 60 : (z >= 13 ? 45 : (z >= 11.5 ? 30 : 0));
        if (Math.abs((map.getPitch() || 0) - want) > 3) {
          try { map.setPitch(want, false); } catch (e) {}
        }
      });
      return true;
    } catch (e) {
      fallbackToVector('高德初始化失败：' + e.message + '，已切回矢量底图。');
      return false;
    }
  }

  var lastPayload = null;

  function renderAMap(payload) {
    if (!state.map || state.sdk !== 'amap' || !payload) return;
    var AMap = window.AMap;
    state.overlays.forEach(function (o) { state.map.remove(o); });
    state.overlays = []; state.markers = []; state.heat = [];
    var maxA = 1;
    payload.data.forEach(function (d) { if (d.aqi > maxA) maxA = d.aqi; });

    payload.data.forEach(function (d) {
      var g = toGCJ(d);
      var color = payload.colorOf(d, payload.metric);
      var norm = Math.min(1.6, d.aqi / 120);
      var size = 10 + norm * 14;
      var content = document.createElement('div');
      content.className = 'amap-dot';
      content.style.width = size + 'px';
      content.style.height = size + 'px';
      content.style.background = color;
      content.style.boxShadow = '0 0 ' + (10 + norm * 12) + 'px ' + color;
      content.title = d.name + ' AQI ' + d.aqi;
      content.addEventListener('click', function () {
        if (window.AQApp && window.AQApp.select) window.AQApp.select(d.name);
      });
      var marker = new AMap.Marker({
        position: g, content: content, offset: new AMap.Pixel(-size / 2, -size / 2),
        zIndex: 100 + Math.round(d.aqi), title: d.name
      });
      marker.setMap(state.map);
      state.overlays.push(marker); state.markers.push(marker);
    });

    /* 轻量热区：给最脏的 12 个城市画半透明圆 */
    payload.data.slice().sort(function (a, b) { return b.aqi - a.aqi; }).slice(0, 12).forEach(function (d) {
      var g = toGCJ(d), color = payload.colorOf(d, payload.metric);
      var circle = new AMap.Circle({
        center: g, radius: 38000 + d.aqi * 900,
        strokeColor: color, strokeOpacity: .35, strokeWeight: 1,
        fillColor: color, fillOpacity: .10, bubble: true
      });
      circle.setMap(state.map);
      circle.__baseR = 38000 + d.aqi * 900;
      circle.__phase = Math.random() * Math.PI * 2;
      state.overlays.push(circle); state.heat.push(circle);
    });

    startRipple();
  }

  /* ---------- 热区涟漪：半径呼吸 + 透明度脉动 ---------- */
  var rippleTimer = null, rippleT = 0;

  function startRipple() {
    if (rippleTimer) return;
    rippleTimer = setInterval(function () {
      rippleT += 0.06;
      for (var i = 0; i < state.heat.length; i++) {
        var c = state.heat[i];
        if (!c || !c.__baseR || !c.setRadius) continue;
        var ph = rippleT + (c.__phase || 0);
        var k = 1 + 0.22 * Math.sin(ph);            /* 半径 ±22% 呼吸 */
        var a = 0.06 + 0.10 * (0.5 + 0.5 * Math.sin(ph));  /* 填充 0.06~0.16 */
        try {
          c.setRadius(c.__baseR * k);
          c.setOptions({ fillOpacity: a, strokeOpacity: 0.18 + 0.30 * (0.5 + 0.5 * Math.sin(ph)) });
        } catch (e) {}
      }
    }, 60);
  }

  function stopRipple() {
    if (rippleTimer) { clearInterval(rippleTimer); rippleTimer = null; }
  }

  /* ---------- 流动光弧：枢纽城市 → 最近的几个城市，光点沿线跑 ---------- */
  var flowTimer = null, flowMarkers = [], flowPaths = [], flowLines = [], flowsOn = true;

  function bezier(a, b, bend) {
    /* a/b 为 [lng,lat]，做一个垂直方向拱起的二次曲线 */
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    var cx = mx - dy / len * len * bend;
    var cy = my + dx / len * len * bend;
    var pts = [];
    for (var i = 0; i <= 44; i++) {
      var t = i / 44, u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0],
                u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
    }
    return pts;
  }

  var __flowsWarned = false;
  function buildFlows(payload) {
    if (!__flowsWarned) { console.warn('[aq] 光弧已停用'); __flowsWarned = true; }
    return;
    var AMap = window.AMap;
    if (!state.map || !AMap) return;
    if (!flowsOn) { flowLines = []; flowMarkers = []; return; }
    if (flowTimer) { clearInterval(flowTimer); flowTimer = null; }
    flowMarkers.forEach(function (m) { state.map.remove(m); });
    flowMarkers = []; flowPaths = [];

    /* 选一批枢纽城市，两两之间距离够远的才连线 —— 形成横跨全国的弧网 */
    var hubs = ['乌鲁木齐', '兰州', '西安', '成都', '昆明', '广州', '深圳', '武汉',
                '郑州', '北京', '天津', '沈阳', '上海', '杭州', '青岛', '哈尔滨', '拉萨', '重庆'];
    var pts = {};
    payload.data.forEach(function (d) { pts[d.name] = toGCJ(d); });

    var list = hubs.filter(function (h) { return pts[h]; });
    var links = [];
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = pts[list[i]], b = pts[list[j]];
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 9 && dist < 34) links.push({ a: list[i], b: list[j], d: dist });
      }
    }
    /* 取最长的一批，视觉上更"横跨" */
    links.sort(function (x, y) { return y.d - x.d; });
    links = links.slice(0, 16);

    flowLines = [];
    links.forEach(function (pair, idx) {
      var a = pts[pair.a], b = pts[pair.b];
      var path = bezier(a, b, (idx % 2 ? 0.2 : -0.2));
      flowPaths.push(path);

      var line = new AMap.Polyline({
        path: path, strokeColor: 'rgba(165,232,255,.62)',
        strokeWeight: 1.1, strokeOpacity: .8, lineJoin: 'round', bubble: true, zIndex: 60
      });
      line.setMap(state.map);
      state.overlays.push(line);
      flowLines.push(line);

      var dot = document.createElement('div');
      dot.className = 'flow-dot';
      var m = new AMap.Marker({
        position: path[0], content: dot, offset: new AMap.Pixel(-3, -3),
        zIndex: 120, bubble: true
      });
      m.setMap(state.map);
      flowMarkers.push(m);
      state.overlays.push(m);
      m.__t = Math.random();
      m.__speed = 0.0032 + Math.random() * 0.003;
      m.__path = path;
    });

    if (!flowMarkers.length) return;
    flowTimer = setInterval(function () {
      for (var k = 0; k < flowMarkers.length; k++) {
        var m = flowMarkers[k];
        m.__t += m.__speed;
        if (m.__t > 1) m.__t -= 1;
        var i = Math.floor(m.__t * (m.__path.length - 1));
        m.setPosition(m.__path[i]);
      }
    }, 40);
  }

  /* ---------- 百度 ---------- */
  function initBMap() {
    if (!cfg.bmapKey) { toast('未配置百度 Key：打开 <b>js/config.js</b> 填入 bmapKey 后刷新。'); return false; }
    var url = 'https://api.map.baidu.com/api?v=1.0&type=webgl&ak=' + encodeURIComponent(cfg.bmapKey) + '&callback=__bmapReady';
    window.__bmapReady = function () { buildBMap(); };
    loadScript(url, function () { if (!state.map) buildBMap(); }, function (e) { toast('百度地图加载失败：' + e.message); });
    return true;
  }

  function buildBMap() {
    if (state.sdk === 'bmap' && state.map) return true;
    var BMapGL = window.BMapGL;
    if (!BMapGL) return false;
    try {
      var map = new BMapGL.Map('baseMap', { enableMapClick: false });
      map.centerAndZoom(new BMapGL.Point(104.2, 35.5), 5);
      if (BMapGL.MapStyle) map.setMapStyleV2 ? null : map.setMapStyle({ style: cfg.bmapStyle || 'dark' });
      map.enableScrollWheelZoom(true);
      map.enableDragging();
      state.map = map; state.sdk = 'bmap';
      renderBMap(lastPayload);
      return true;
    } catch (e) {
      fallbackToVector('百度初始化失败：' + e.message + '，已切回矢量底图。');
      return false;
    }
  }

  function renderBMap(payload) {
    if (!state.map || state.sdk !== 'bmap' || !payload) return;
    var BMapGL = window.BMapGL;
    state.overlays.forEach(function (o) { state.map.removeOverlay(o); });
    state.overlays = [];

    payload.data.forEach(function (d) {
      var b = toBD(d), color = payload.colorOf(d, payload.metric);
      var norm = Math.min(1.6, d.aqi / 120);
      var circle = new BMapGL.Circle(new BMapGL.Point(b[0], b[1]), 42000 + d.aqi * 800, {
        strokeColor: color, strokeOpacity: .45, strokeWeight: 1,
        fillColor: color, fillOpacity: .28
      });
      circle.addEventListener('click', function () {
        if (window.AQApp && window.AQApp.select) window.AQApp.select(d.name);
      });
      state.map.addOverlay(circle);
      state.overlays.push(circle);
    });
  }

  /* ---------- 对外 API ---------- */
  function setProvider(p) {
    p = p || 'vector';
    /* auto：有高德 Key 就用高德，其次百度，都没有则矢量（不需要手动切换） */
    if (p === 'auto') {
      p = cfg.amapKey ? 'amap' : (cfg.bmapKey ? 'bmap' : 'vector');
    }
    var stage = document.querySelector('.map-stage');
    if (p === 'amap' && !cfg.amapKey) { return 'vector'; }
    if (p === 'bmap' && !cfg.bmapKey) { return 'vector'; }

    state.provider = p;
    if (stage) stage.classList.toggle('on-basemap', p !== 'vector');
    var bg = document.getElementById('bgLayer');
    if (bg) bg.classList.toggle('on-basemap', p !== 'vector');

    if (p === 'vector') { setLabel('VECTOR'); return 'vector'; }
    if (p === 'amap') {
      setLabel('AMAP · 高德');
      if (state.sdk === 'amap' && state.map) { renderAMap(lastPayload); return 'amap'; }
      initAMap();
      return 'amap';
    }
    if (p === 'bmap') {
      setLabel('BMAP · 百度');
      if (state.sdk === 'bmap' && state.map) { renderBMap(lastPayload); return 'bmap'; }
      initBMap();
      return 'bmap';
    }
    return 'vector';
  }

  function setLabel(t) {
    var el = document.getElementById('baseLabel');
    if (el) el.textContent = t;
  }

  function update(data, metric, colorOf) {
    lastPayload = { data: data || [], metric: metric, colorOf: colorOf };
    if (state.provider === 'amap') renderAMap(lastPayload);
    else if (state.provider === 'bmap') renderBMap(lastPayload);
  }

  function focus(name) {
    if (!lastPayload) return;
    var d = null;
    for (var i = 0; i < lastPayload.data.length; i++) if (lastPayload.data[i].name === name) { d = lastPayload.data[i]; break; }
    if (!d || !state.map) return;
    try {
      if (state.sdk === 'amap') {
        var g = toGCJ(d);
        state.map.setZoomAndCenter(7, g);
      } else if (state.sdk === 'bmap') {
        var b = toBD(d);
        state.map.centerAndZoom(new window.BMapGL.Point(b[0], b[1]), 8);
      }
    } catch (e) { /* ignore */ }
  }

  /** 取一个可用的地图实例（没有就初始化），供三级联动复用 */
  function ensure(cb) {
    if (state.map) return cb(state.map, state.sdk);
    var p = cfg.amapKey ? 'amap' : (cfg.bmapKey ? 'bmap' : null);
    if (!p) return cb(null, null);
    var tries = 0;
    setProvider(p);
    var t = setInterval(function () {
      if (state.map) { clearInterval(t); cb(state.map, state.sdk); }
      else if (++tries > 100) { clearInterval(t); cb(null, null); }
    }, 100);
  }

  /** 三级联动时隐藏城市点/热区，保留底图 */
  function setMarkers(show) {
    if (!show && flowTimer) { clearInterval(flowTimer); flowTimer = null; }
    if (show && lastPayload) buildFlows(lastPayload);
    if (!state.map) return;
    state.markers.forEach(function (m) { show ? m.show() : m.hide(); });
    state.heat.forEach(function (c) { show ? c.show() : c.hide(); });
  }

  function setHeat(show) {
    if (!state.map) return;
    state.heat.forEach(function (c) { show ? c.show() : c.hide(); });
  }

  function setFlows(show) {
    flowsOn = !!show;
    return;
    if (!state.map) return;
    flowLines.forEach(function (l) { show ? l.show() : l.hide(); });
    flowMarkers.forEach(function (m) { show ? m.show() : m.hide(); });
  }

  function getMap() { return state.map; }

  function resize() { if (state.map && state.map.resize) { try { state.map.resize(); } catch (e) {} } }

  window.BaseMap = {
    resize: resize,
    setFlows: setFlows,
    setSatellite: function (b) { if (window.__setSatellite) window.__setSatellite(b); },
    setHeat: setHeat,
    ensure: ensure,
    setMarkers: setMarkers,
    getMap: getMap,
    setProvider: setProvider,
    update: update,
    focus: focus,
    provider: function () { return state.provider; },
    config: cfg
  };
})();
