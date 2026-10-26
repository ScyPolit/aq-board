/* ============================================================================
   渲染层 v9 —— 地图 / KPI / 排名 / 仪表盘 / 等级环 / 污染物柱 / 趋势 / 明细
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var METRICS = [
    { key: 'aqi', label: 'AQI', unit: '', limit: 100 },
    { key: 'pm2_5', label: 'PM2.5', unit: 'μg/m³', limit: 75 },
    { key: 'pm10', label: 'PM10', unit: 'μg/m³', limit: 150 },
    { key: 'sulphur_dioxide', label: 'SO₂', unit: 'μg/m³', limit: 150 },
    { key: 'nitrogen_dioxide', label: 'NO₂', unit: 'μg/m³', limit: 80 },
    { key: 'ozone', label: 'O₃', unit: 'μg/m³', limit: 160 }
  ];
  var POLLS = [
    { key: 'pm2_5', name: 'PM2.5', limit: 75 },
    { key: 'pm10', name: 'PM10', limit: 150 },
    { key: 'so2', name: 'SO₂', limit: 150 },
    { key: 'no2', name: 'NO₂', limit: 80 },
    { key: 'o3', name: 'O₃', limit: 160 }
  ];
  var HUB = '北京';

  var state = {
    data: [], summary: null,
    metric: 'aqi', source: 'simulation',
    selected: null, tick: 0,
    dynamic: true, timer: null,
    sortKey: 'aqi-desc', query: '', prevAvg: null, loading: false
  };

  var mapChart = null, gaugeChart = null, pieChart = null, barChart = null, trendChart = null;
  var mapReady = false;
  var STATIC = /[?&]static=1/.test(location.search);

  /* ---------------- utils ---------------- */
  function metricDef(k) { for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === k) return METRICS[i]; return METRICS[0]; }
  function valOf(d, k) { return k === 'aqi' ? d.aqi : (d[k] || 0); }
  function levelValOf(d, k) {
    if (k === 'aqi') return d.aqi;
    var l = d.iaqis || [];
    for (var i = 0; i < l.length; i++) if (l[i].key === k) return l[i].val;
    return 0;
  }
  function colorOf(d, k) { return window.AQ.levelOf(levelValOf(d, k)).color; }
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt1(v) { return (v == null) ? '—' : (v >= 100 ? Math.round(v) : (+v).toFixed(1)); }
  function countUp(el, from, to, dur, dec) {
    if (!el) return;
    var t0 = performance.now(), d = dur || 650;
    (function step(t) {
      var k = (t - t0) / d;
      if (!isFinite(k)) k = 1;
      k = k < 0 ? 0 : (k > 1 ? 1 : k);
      var e = 1 - Math.pow(1 - k, 3);
      var v = from + (to - from) * e;
      el.textContent = dec ? v.toFixed(dec) : Math.round(v);
      if (k < 1) requestAnimationFrame(step);
    })(performance.now());
  }

  /* ---------------- stage ---------------- */
  function fitStage() {
    var stage = $('#stage');
    var d = document.documentElement;
    var w = d.clientWidth || window.innerWidth;
    var h = d.clientHeight || window.innerHeight;
    /* 全屏：按视口纵横比把舞台「加宽或加高」，既铺满又不裁切 */
    var stageEl = stage;
    if (document.fullscreenElement) {
      var sc = h / 1080;                       /* 先按高度铺满 */
      var needW = w / sc;                      /* 需要的设计宽度 */
      stageEl.style.width = Math.round(needW) + 'px';
      stageEl.style.height = '1080px';
      stageEl.style.transformOrigin = '0 0';
      stageEl.style.transform = 'translate(0px,0px) scale(' + sc + ')';
      return;
    } else {
      stageEl.style.width = '';
      stageEl.style.height = '';
    }
    var s = Math.min(w / 1920, h / 1080);

    /* 用绝对定位 + translate/scale，保证任何窗口尺寸都精确居中且不裁切。
       （只写 scale 时，元素仍以左上角参与布局，会左边留白、右边被切） */
    stage.style.zoom = '';
    stage.style.transformOrigin = '0 0';
    var x = Math.round((w - 1920 * s) / 2);
    var y = Math.round((h - 1080 * s) / 2);
    stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';

    document.body.classList.remove('scrollable');
    if (window.BaseMap && window.BaseMap.resize) window.BaseMap.resize();
    if (window.Cascade && window.Cascade.resize) window.Cascade.resize();
  }

  /* ---------------- data flow ---------------- */
  function refresh(manual) {
    if (state.loading) return Promise.resolve();
    if (state.source === 'realtime') {
      state.loading = true;
      var live = $('#srcLabel');
      live.textContent = 'FETCH 0/' + window.CITIES.length;
      $('#liveBadge').classList.add('warn');
      return window.AQ.fetchRealtime(window.CITIES, function (done, total) {
        live.textContent = 'FETCH ' + done + '/' + total;
      }).then(function (data) {
        state.loading = false;
        $('#liveBadge').classList.remove('warn');
        if (data && data.length) { state.data = data; commit(); live.textContent = '实时 API'; }
        else { live.textContent = 'API 失败'; }
      });
    }
    state.tick += 1;
    state.data = window.AQ.simulate(state.tick);
    commit();
    return Promise.resolve();
  }

  function commit() {
    state.summary = window.AQ.summarize(state.data);
    try { document.dispatchEvent(new CustomEvent('aq:update')); } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent('aq:tick', { detail: {
        data: state.data, summary: state.summary, ts: Date.now()
      } }));
    } catch (e) {}
    renderKpi();
    renderLevels();
    renderRanks();
    renderMap();
    renderGauge();
    renderPie();
    renderBar();
    renderTrend();
    renderTable();
    if (state.selected) {
      var d = byName(state.selected);
      if (d) renderCityCard(d); else clearSelection();
    }
  }

  function byName(n) {
    for (var i = 0; i < state.data.length; i++) if (state.data[i].name === n) return state.data[i];
    return null;
  }

  /* ---------------- KPI ---------------- */
  function renderKpi() {
    var s = state.summary, lv = window.AQ.levelOf(s.avgAqi);

    countUp($('#kCities'), 0, s.count, 700);
    $('#kCitiesSub').textContent = '覆盖全国 ' + s.count + ' 个监测点';

    var from = state.prevAvg == null ? Math.max(0, s.avgAqi - 14) : state.prevAvg;
    countUp($('#kAvg'), from, s.avgAqi, 800);
    var sub = $('#kAvgSub');
    if (state.prevAvg == null) { sub.textContent = lv.label + ' · 较上一时段 —'; }
    else {
      var dv = s.avgAqi - state.prevAvg;
      sub.textContent = lv.label + ' · ' + (dv >= 0 ? '↑ ' : '↓ ') + Math.abs(dv) + ' 较上一时段';
      sub.style.color = dv > 0 ? 'var(--amber)' : 'var(--aq1)';
    }
    state.prevAvg = s.avgAqi;

    var excellent = s.counts[0];
    countUp($('#kGood'), 0, excellent, 700);
    $('#kGoodSub').textContent = '占比 ' + Math.round(excellent / s.count * 100) + '% · AQI 0–50';

    countUp($('#kPolluted'), 0, s.polluted, 700);
    $('#kPollutedSub').textContent = '占比 ' + Math.round(s.polluted / s.count * 100) + '% · AQI > 100';

    $('#kPrimary').textContent = s.primary;
    $('#kPrimary').style.color = s.primary === '—' ? '' : 'var(--amber)';
    $('#kPrimarySub').textContent = s.primaryCount ? s.primaryCount + ' 城颗粒物/臭氧为主' : '暂无';

    drawSpark($('#kAvgSpark'), window.AQ.series24(s.avgAqi, 'kpi').map(function (p) { return p.v; }));
  }

  function drawSpark(svg, vals) {
    if (!svg) return;
    var W = 64, H = 22, pad = 2;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = Math.max(1, max - min);
    var pts = vals.map(function (v, i) {
      return [i / (vals.length - 1) * W, H - pad - (v - min) / span * (H - pad * 2)];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    svg.innerHTML =
      '<path d="' + line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z" fill="rgba(86,216,255,.18)"/>' +
      '<path d="' + line + '" fill="none" stroke="rgba(140,232,255,.9)" stroke-width=".8"/>' +
      '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" r="1.4" fill="#8ce8ff"/>';
  }

  /* ---------------- level split ---------------- */
  function renderLevels() {
    var s = state.summary, total = s.count || 1;
    var bar = $('#levelBar'), legend = $('#levelLegend');
    if (!bar || !legend) return;
    bar.innerHTML = ''; legend.innerHTML = '';
    window.AQ.LEVELS.forEach(function (lv, i) {
      var c = s.counts[i] || 0;
      var seg = document.createElement('i');
      seg.style.width = (c / total * 100) + '%';
      seg.style.background = lv.color;
      seg.style.opacity = c ? '.85' : '0';
      bar.appendChild(seg);
      var li = document.createElement('li');
      li.innerHTML = '<span class="sw" style="background:' + lv.color + '"></span>' +
        '<span class="nm">' + lv.label + '</span>' +
        '<span class="ct">' + c + '</span>' +
        '<span class="pc">' + (c / total * 100).toFixed(1) + '%</span>';
      legend.appendChild(li);
    });
  }

  /* ---------------- ranks ---------------- */
  function renderRanks() {
    var sorted = state.data.slice().sort(function (a, b) { return a.aqi - b.aqi; });
    fillRank($('#rankBest'), sorted.slice(0, 7), false);
    var t = sorted.slice().reverse().slice(0, 7);
    fillRank($('#rankWorst'), t, true);
  }

  function fillRank(ul, rows, worst) {
    var max = 1;
    rows.forEach(function (d) { if (d.aqi > max) max = d.aqi; });
    ul.innerHTML = '';
    rows.forEach(function (d, i) {
      var lv = window.AQ.levelOf(d.aqi);
      var li = document.createElement('li');
      li.innerHTML = '<span class="rk">' + pad2(i + 1) + '</span>' +
        '<span class="ct">' + d.name + '</span>' +
        '<span class="bar"><i style="width:' + (d.aqi / max * 100) + '%;background:' +
          'linear-gradient(90deg,' + hexA(lv.color, .25) + ',' + lv.color + ')"></i></span>' +
        '<span class="vv" style="color:' + lv.color + '">' + d.aqi + '</span>';
      li.addEventListener('click', function () { selectCity(d.name); });
      ul.appendChild(li);
    });
  }

  /* ---------------- map ---------------- */
  function registerMap() {
    if (mapReady || !window.CHINA_GEOJSON) return;
    var feats = window.CHINA_GEOJSON.features.filter(function (f) { return f.properties && f.properties.name; });
    echarts.registerMap('cn-grid', { type: 'FeatureCollection', features: feats });
    mapReady = true;
  }

  function graticule() {
    var out = [], i;
    for (i = 75; i <= 135; i += 10) {
      var a = []; for (var la = 18; la <= 54; la += 2) a.push([i, la]);
      out.push({ coords: a });
    }
    for (i = 20; i <= 50; i += 10) {
      var b = []; for (var lo = 73; lo <= 135; lo += 2) b.push([lo, i]);
      out.push({ coords: b });
    }
    return out;
  }

  function mapOption(view) {
    var data = state.data, key = state.metric, def = metricDef(key);
    var coord = {};
    data.forEach(function (d) { coord[d.name] = [d.lng, d.lat]; });

    var heat = data.map(function (d) {
      var t = Math.min(2.6, valOf(d, key) / def.limit), c = colorOf(d, key);
      var a = 0.09 + 0.30 * Math.min(1, t / 1.5);
      return {
        value: [d.lng, d.lat, valOf(d, key)],
        symbolSize: 18 + t * 40,
        itemStyle: {
          color: { type: 'radial', x: .5, y: .5, r: .5, colorStops: [
            { offset: 0, color: hexA(c, a) }, { offset: .45, color: hexA(c, a * .45) }, { offset: 1, color: hexA(c, 0) }] }
        }
      };
    });

    var dots = data.map(function (d) {
      var t = Math.min(2.6, valOf(d, key) / def.limit), c = colorOf(d, key);
      return {
        name: d.name, value: [d.lng, d.lat, valOf(d, key)],
        symbolSize: 4.6 + t * 4.2,
        itemStyle: { color: c, shadowBlur: 14, shadowColor: hexA(c, .9), borderColor: 'rgba(4,12,18,.9)', borderWidth: .7 },
        __d: d
      };
    });

    var sorted = [];

    var sel = state.selected ? byName(state.selected) : null;

    var opt = {
      animationDurationUpdate: 650,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item', backgroundColor: 'rgba(6,14,22,.94)',
        borderColor: 'rgba(124,192,234,.25)', borderWidth: 1, padding: 0,
        extraCssText: 'box-shadow:0 20px 50px rgba(0,0,0,.6);backdrop-filter:blur(10px);border-radius:2px;',
        formatter: function (p) {
          var d = p.data && p.data.__d; if (!d) return '';
          var lv = window.AQ.levelOf(d.aqi);
          var rows = [['PM2.5', d.pm2_5], ['PM10', d.pm10], ['SO₂', d.sulphur_dioxide], ['NO₂', d.nitrogen_dioxide], ['O₃', d.ozone]]
            .map(function (r) {
              return '<span style="display:flex;justify-content:space-between;gap:22px">' +
                '<span style="color:#5f7a8d">' + r[0] + '</span>' +
                '<span style="color:#dfeef9;font-family:monospace">' + r[1] + '</span></span>';
            }).join('');
          return '<div style="padding:9px 11px;min-width:148px">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:6px">' +
            '<span style="font-size:12.5px;letter-spacing:.1em;color:#eaf6ff">' + d.name + '</span>' +
            '<span style="font-family:monospace;font-size:15px;color:' + lv.color + '">' + d.aqi + '</span></div>' +
            '<div style="height:1px;background:rgba(124,192,234,.16);margin-bottom:6px"></div>' +
            '<div style="font-size:10px;line-height:1.85">' + rows + '</div></div>';
        }
      },
      geo: {
        map: 'cn-grid', roam: true,
        zoom: (view && view.zoom) || 1,
        center: view && view.center ? view.center : undefined,
        scaleLimit: { min: 0.85, max: 9 },
        layoutCenter: ['50%', '46%'], layoutSize: '122%',
        itemStyle: {
          areaColor: 'rgba(9,23,38,.72)', borderColor: 'rgba(122,206,244,.42)', borderWidth: .9,
          shadowColor: 'rgba(68,178,255,.55)', shadowBlur: 16, shadowOffsetY: 4
        },
        emphasis: {
          itemStyle: { areaColor: 'rgba(48,126,178,.22)', borderColor: 'rgba(190,240,255,.95)', shadowColor: 'rgba(120,220,255,.65)', shadowBlur: 22 },
          label: { show: true, color: '#d6f2ff', fontSize: 10, fontFamily: 'monospace' }
        },
        select: { disabled: true }, label: { show: false }, z: 2
      },
      series: [
        { type: 'scatter', coordinateSystem: 'geo', z: 3, silent: true, symbol: 'circle',
          data: heat.map(function (h) { return { value: h.value, itemStyle: h.itemStyle, symbolSize: h.symbolSize }; }) },

        { type: 'scatter', coordinateSystem: 'geo', z: 6, symbol: 'circle', data: dots,
          emphasis: { scale: 1.9, itemStyle: { borderColor: '#eaf6ff', borderWidth: 1 } } }
      ]
    };
    if (sel) {
      opt.series.push({
        type: 'scatter', coordinateSystem: 'geo', z: 9, silent: true, symbol: 'circle', symbolSize: 26,
        data: [{ value: [sel.lng, sel.lat] }],
        itemStyle: { color: 'transparent', borderColor: window.AQ.levelOf(sel.aqi).color, borderWidth: 1.2,
          shadowBlur: 16, shadowColor: window.AQ.levelOf(sel.aqi).color }
      });
    }
    return opt;
  }

  /* 记住用户缩放/平移后的视图，刷新数据时不要把它弹回去 */
  function viewState() {
    if (!mapChart) return null;
    try {
      var o = mapChart.getOption(), g = o && o.geo && o.geo[0];
      if (!g || !g.zoom) return null;
      return { zoom: g.zoom, center: g.center };
    } catch (e) { return null; }
  }
  var geoHome = null;
  function applyMapOption() {
    if (!mapChart) return;
    mapChart.setOption(mapOption(viewState()), { notMerge: false, lazyUpdate: true });
    if (!geoHome) {
      var g = viewState();
      if (g && g.center) geoHome = { center: g.center, zoom: g.zoom };
    }
  }

  function renderMap() {
    registerMap();
    if (!mapChart) {
      mapChart = echarts.init($('#mapChart'), null, { renderer: 'canvas' });
      mapChart.on('click', function (p) { if (p.data && p.data.__d) selectCity(p.data.__d.name); });
      /* 双击复位到初始视野（缩得太远时好用） */
      mapChart.on('dblclick', function () {
        mapChart.setOption(mapOption(geoHome || { zoom: 1 }), { notMerge: false, lazyUpdate: true });
      });
    }
    applyMapOption();
    $('#mapMetricLabel').textContent = metricDef(state.metric).label + ' 实时分布';
    if (window.BaseMap) window.BaseMap.update(state.data, state.metric, colorOf);
  }

  /* ---------------- gauge ---------------- */
  function renderGauge() {
    if (!$('#gaugeChart').offsetParent) { state.dirtyGauge = true; return; }
    var sel = state.selected ? byName(state.selected) : null;
    var v = sel ? sel.aqi : state.summary.avgAqi;
    var lv = window.AQ.levelOf(v);
    if (!gaugeChart) gaugeChart = echarts.init($('#gaugeChart'), null, { renderer: 'canvas' });
    gaugeChart.setOption({ animationDurationUpdate: 620, animationEasingUpdate: 'cubicOut',
      backgroundColor: 'transparent',
      series: [{
        type: 'gauge', min: 0, max: 300, startAngle: 215, endAngle: -35,
        center: ['50%', '58%'], radius: '98%',
        axisLine: { lineStyle: { width: 5, color: [[1, 'rgba(124,192,234,.13)']] } },
        progress: { show: true, width: 5, roundCap: true, itemStyle: { color: lv.color, shadowBlur: 12, shadowColor: lv.color } },
        pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: true, offsetCenter: [0, '-2%'],
          fontSize: 30, fontWeight: 200, fontFamily: 'monospace', color: lv.color,
          formatter: function (x) { return Math.round(x); }
        },
        anchor: { show: false },
        data: [{ value: v, name: sel ? sel.name : '全国均值' }]
      }],
      graphic: [
        { type: 'text', left: 'center', top: '80%',
          style: { text: sel ? sel.name + ' · AQI' : '全国均值 · AQI', fill: '#5f7a8d', fontSize: 9, fontFamily: 'monospace' } },
        { type: 'text', left: 'center', top: '89%',
          style: { text: lv.label, fill: lv.color, fontSize: 11, letterSpacing: 2 } }
      ]
    }, true);
    $('#gaugeCity').textContent = sel ? sel.name : 'Nationwide';
  }

  /* ---------------- pie ---------------- */
  function renderPie() {
    var s = state.summary;
    var data = window.AQ.LEVELS.map(function (lv, i) {
      return { name: lv.label, value: s.counts[i] || 0, itemStyle: { color: lv.color } };
    }).filter(function (d) { return d.value > 0; });

    if (!pieChart) pieChart = echarts.init($('#pieChart'), null, { renderer: 'canvas' });
    pieChart.setOption({ animationDurationUpdate: 620, animationEasingUpdate: 'cubicOut',
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item', backgroundColor: 'rgba(6,14,22,.94)', borderColor: 'rgba(124,192,234,.25)',
        textStyle: { color: '#dfeef9', fontSize: 11 },
        formatter: function (p) { return p.name + ' · <b>' + p.value + '</b> 城 (' + p.percent + '%)'; }
      },
      legend: {
        orient: 'vertical', right: '3%', top: 'middle', itemWidth: 8, itemHeight: 2, itemGap: 7,
        textStyle: { color: '#9fb9cc', fontSize: 9, fontFamily: 'monospace' },
        formatter: function (n) {
          var d = data.filter(function (x) { return x.name === n; })[0];
          return n + '  ' + (d ? d.value : 0);
        }
      },
      series: [{
        type: 'pie', radius: ['50%', '76%'], center: ['36%', '52%'],
        avoidLabelOverlap: false, label: { show: false }, labelLine: { show: false },
        itemStyle: { borderColor: 'rgba(5,12,19,.9)', borderWidth: 2 },
        data: data,
        emphasis: { scale: true, scaleSize: 4, itemStyle: { shadowBlur: 18, shadowColor: 'rgba(86,216,255,.5)' } }
      }],
      graphic: [
        { type: 'text', left: '36%', top: '41%', silent: true,
          style: { text: String(s.count), fill: '#eef8ff', fontSize: 19, fontFamily: 'monospace', textAlign: 'center' } },
        { type: 'text', left: '36%', top: '56%', silent: true,
          style: { text: 'STATIONS', fill: '#3d5566', fontSize: 7, fontFamily: 'monospace', textAlign: 'center' } }
      ]
    });
  }

  /* ---------------- bar ---------------- */
  function renderBar() {
    var avg = state.summary.avg;
    var names = [], vals = [], cols = [], raw = [];
    var ia = window.AQ.calcChinaAQI({
      pm2_5: avg.pm2_5, pm10: avg.pm10, sulphur_dioxide: avg.so2, nitrogen_dioxide: avg.no2, ozone: avg.o3
    }).iaqis;
    var map = {};
    ia.forEach(function (x) { map[x.key] = x.val; });
    POLLS.forEach(function (p) {
      names.push(p.name); raw.push(avg[p.key]);
      cols.push(window.AQ.levelOf(map[p.key] || 0).color);
    });
    var max = Math.max.apply(null, raw) * 1.25 || 100;

    if (!barChart) barChart = echarts.init($('#barChart'), null, { renderer: 'canvas' });
    barChart.setOption({ animationDurationUpdate: 620, animationEasingUpdate: 'cubicOut',
      backgroundColor: 'transparent',
      grid: { left: 8, right: 8, top: 22, bottom: 18 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(86,216,255,.06)' } },
        backgroundColor: 'rgba(6,14,22,.94)', borderColor: 'rgba(124,192,234,.25)',
        textStyle: { color: '#dfeef9', fontSize: 11 },
        formatter: function (ps) {
          var i = ps[0].dataIndex;
          return ps[0].name + '<br/>均值 <b>' + fmt1(raw[i]) + '</b> μg/m³<br/>' +
            '<span style="color:#5f7a8d">二级标准 ' + POLLS[i].limit + '</span>';
        }
      },
      xAxis: {
        type: 'category', data: names,
        axisLine: { lineStyle: { color: 'rgba(124,192,234,.14)' } },
        axisTick: { show: false },
        axisLabel: { color: '#8fa9bd', fontSize: 8.5, fontFamily: 'monospace', margin: 7 }
      },
      yAxis: { type: 'value', max: max, show: false },
      series: [{
        type: 'bar', data: raw, barWidth: 18,
        itemStyle: {
          borderRadius: [1, 1, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(140,232,255,.9)' }, { offset: 1, color: 'rgba(86,216,255,.16)' }
          ])
        },
        label: {
          show: true, position: 'top', color: '#dfeef9', fontSize: 9, fontFamily: 'monospace',
          formatter: function (p) { return fmt1(p.value); }
        },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(255,169,61,.35)', type: 'dashed', width: .8 }, data: [] }
      }],
      colorBy: 'series'
    }, true);

    // 每个柱用自身等级色顶到渐变上
    barChart.setOption({ animationDurationUpdate: 620, animationEasingUpdate: 'cubicOut',
      series: [{
        itemStyle: {
          color: function (p) {
            var c = cols[p.dataIndex];
            return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: c }, { offset: 1, color: hexA(c, .12) }
            ]);
          }
        }
      }]
    });
  }

  /* ---------------- trend ---------------- */
  /* ---------------- 24H 趋势：多污染物叠加（参考视频的动态折线图） ---------------- */
  var TREND_SERIES = [
    { key: 'pm2_5', label: 'PM2.5', color: '#56d8ff', axis: 0 },
    { key: 'pm10', label: 'PM10', color: '#ffd479', axis: 0 },
    { key: 'so2', label: 'SO₂', color: '#9be15d', axis: 1 },
    { key: 'no2', label: 'NO₂', color: '#ff8fa3', axis: 1 },
    { key: 'o3', label: 'O₃', color: '#c084fc', axis: 1 }
  ];

  function trendHours() {
    var out = [];
    for (var i = 23; i >= 0; i--) {
      var d = new Date(Date.now() - i * 3600 * 1000);
      out.push(i === 0 ? '现在' : pad2(d.getHours()) + ':00');
    }
    return out;
  }

  function renderTrend() {
    var avg = state.summary.avg || {};
    var key = 'trend|' + state.source;
    var nowMin = Math.floor(Date.now() / 20000);

    if (!state.trendBuf || state.trendBuf.key !== key) {
      state.trendBuf = { key: key, data: {}, lastMin: nowMin };
      TREND_SERIES.forEach(function (t) {
        var base = avg[t.key] || 10;
        state.trendBuf.data[t.key] = window.AQ.series24(base, 'trend' + t.key, .18)
          .map(function (p) { return Math.round(p.v * 10) / 10; });
      });
    }

    /* 每次刷新：右端锚定最新值；每 20 秒整窗左移一格 → 曲线像视频一样流动 */
    var shifted = state.trendBuf.lastMin !== nowMin;
    if (shifted) state.trendBuf.lastMin = nowMin;
    TREND_SERIES.forEach(function (t) {
      var arr = state.trendBuf.data[t.key];
      arr[arr.length - 1] = Math.round((avg[t.key] || arr[arr.length - 1]) * 10) / 10;
      if (shifted) { arr.push(arr[arr.length - 1]); arr.shift(); }
    });

    var hours = trendHours();
    var series = TREND_SERIES.map(function (t) {
      var arr = state.trendBuf.data[t.key];
      return {
        name: t.label,
        type: 'line',
        yAxisIndex: t.axis,
        data: arr,
        smooth: .45,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 4,
        showAllSymbol: false,
        lineStyle: { width: 1.4, color: t.color, shadowColor: t.color, shadowBlur: 10 },
        itemStyle: { color: t.color, borderColor: '#04121b', borderWidth: 1 },
        emphasis: { focus: 'series' },
        /* 末端标签：像视频那样在线的右端标出名称 + 当前值 */
        endLabel: {
          show: true,
          formatter: function (p) { return t.label + ' ' + p.value; },
          color: t.color,
          fontSize: 8,
          fontFamily: 'monospace',
          distance: 3
        },
        areaStyle: t.key === 'pm2_5' ? {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(86,216,255,.22)' }, { offset: 1, color: 'rgba(86,216,255,0)' }])
        } : undefined
      };
    });

    if (!trendChart) trendChart = echarts.init($('#trendChart'), null, { renderer: 'canvas' });
    trendChart.setOption({
      animationDurationUpdate: 620, animationEasingUpdate: 'cubicOut',
      animationDuration: 700,
      backgroundColor: 'transparent',
      grid: { left: 30, right: 74, top: 20, bottom: 18 },
      legend: {
        data: TREND_SERIES.map(function (t) { return t.label; }),
        top: 0, right: 4, itemWidth: 10, itemHeight: 3, itemGap: 10,
        textStyle: { color: '#b9d8ec', fontSize: 9, fontFamily: 'monospace' },
        icon: 'rect'
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(6,14,22,.94)', borderColor: 'rgba(124,192,234,.25)',
        textStyle: { color: '#dfeef9', fontSize: 10 },
        axisPointer: { lineStyle: { color: 'rgba(86,216,255,.35)' } },
        formatter: function (ps) {
          var h = '<span style="font-family:monospace;font-size:9px;color:#5f7a8d">' + ps[0].axisValue + '</span>';
          ps.forEach(function (x) {
            h += '<br/>' + x.marker + '<span style="font-size:9px">' + x.seriesName + '</span> ' +
              '<b style="font-family:monospace">' + x.data + '</b>';
          });
          return h;
        }
      },
      xAxis: {
        type: 'category', data: hours, boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(124,192,234,.13)' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#6f8a9e', fontSize: 8, fontFamily: 'monospace', interval: 5, margin: 6,
          formatter: function (v) { return v === '现在' ? '现在' : v; }
        }
      },
      yAxis: [
        {
          type: 'value', scale: true, splitNumber: 3,
          splitLine: { lineStyle: { color: 'rgba(124,192,234,.05)' } },
          axisLabel: { color: '#6f8a9e', fontSize: 7.5, fontFamily: 'monospace', margin: 4 }
        },
        {
          type: 'value', scale: true, splitNumber: 3, position: 'right',
          splitLine: { show: false },
          axisLabel: { color: '#8a7ea8', fontSize: 7, fontFamily: 'monospace', margin: 2 }
        }
      ],
      series: series
    }, { notMerge: false, lazyUpdate: true });
    $('#trendMetric').textContent = '5 项叠加';
  }

  /* ---------------- table ---------------- */
  function tableRows() {
    var q = state.query.trim();
    var rows = state.data.filter(function (d) { return !q || d.name.indexOf(q) >= 0 || (d.province || '').indexOf(q) >= 0; });
    var k = state.sortKey;
    rows.sort(function (a, b) {
      switch (k) {
        case 'aqi-asc': return a.aqi - b.aqi;
        case 'pm25-desc': return b.pm2_5 - a.pm2_5;
        case 'pm10-desc': return b.pm10 - a.pm10;
        case 'name-asc': return a.name.localeCompare(b.name, 'zh');
        default: return b.aqi - a.aqi;
      }
    });
    return rows;
  }

  function renderTable() {
    var rows = tableRows(), html = '';
    rows.forEach(function (d, i) {
      var lv = window.AQ.levelOf(d.aqi);
      html += '<tr data-name="' + d.name + '"' + (state.selected === d.name ? ' class="on"' : '') + '>' +
        '<td>' + pad2(i + 1) + '</td><td>' + d.name + '</td><td>' + (d.province || '—') + '</td>' +
        '<td class="num" style="color:' + lv.color + '">' + d.aqi + '</td>' +
        '<td><span class="lv" style="color:' + lv.color + '">' + lv.label + '</span></td>' +
        '<td class="num">' + fmt1(d.pm2_5) + '</td><td class="num">' + fmt1(d.pm10) + '</td>' +
        '<td class="num">' + fmt1(d.sulphur_dioxide) + '</td><td class="num">' + fmt1(d.nitrogen_dioxide) + '</td>' +
        '<td class="num">' + fmt1(d.ozone) + '</td>' +
        '<td style="text-align:right;color:var(--ink-3);font-size:10px">' + d.primary + '</td></tr>';
    });
    $('#cityTableBody').innerHTML = html || '<tr><td colspan="11" class="tbl-empty">没有匹配的城市，换个关键字试试</td></tr>';
    $$('#cityTableBody tr').forEach(function (tr) {
      if (!tr.dataset.name) return;
      tr.addEventListener('click', function () { selectCity(tr.dataset.name, true); });
    });
  }


  /* ---------------- 统一飞行入口（两段式，禁止跳变） ---------------- */
  var flyState = { timer: null, token: 0 };

  function flyToCity(name, opt) {
    opt = opt || {};
    var d = byName(name);
    var map = window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap();
    if (!d || !map) return;
    var zoomTo = opt.zoom || 9.5;
    var dur = opt.duration || 900;
    var token = ++flyState.token;
    var done = false;

    window.__aqFlying = true;
    try { map.setStatus({ dragEnable: true }); } catch (e) {}

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(flyState.timer);
      try { map.off('mousedown', cancel); map.off('wheel', cancel); } catch (e) {}
      setTimeout(function () { window.__aqFlying = false; }, 220);
      var ms = document.getElementById('msState');
      if (ms) {
        ms.textContent = '已定位 ' + name;
        ms.classList.add('on');
        setTimeout(function () { ms.classList.remove('on'); }, 2000);
      }
    }

    function cancel() {
      if (done) return;
      done = true;
      flyState.token++;
      clearTimeout(flyState.timer);
      try { map.off('mousedown', cancel); map.off('wheel', cancel); } catch (e) {}
      window.__aqFlying = false;
    }
    try { map.on('mousedown', cancel); map.on('wheel', cancel); } catch (e) {}

    var g = [d.lng, d.lat];
    /* 第一段：只平移，zoom 不变（260ms） */
    try {
      var z0 = map.getZoom();
      map.setZoomAndCenter(z0, g, false, 260);
    } catch (e) {}

    flyState.timer = setTimeout(function () {
      if (token !== flyState.token) return;
      /* 第二段：拉到目标 zoom 并抬头（700ms） */
      try {
        map.setZoomAndCenter(zoomTo, g, false, 700);
        setTimeout(function () { try { map.setPitch(45, false, 400); } catch (e) {} }, 380);
      } catch (e) {}
      setTimeout(finish, 760);
    }, 270);
  }

  window.flyToCity = flyToCity;



  /* ---------------- 全屏：铺满屏幕（cover），不留黑边 ---------------- */
  function bindFullscreenRefit() {
    document.addEventListener('fullscreenchange', function () {
      var bg = document.querySelector('.bg-layer');
      if (bg) bg.classList.toggle('satellite', false);
      setTimeout(function () {
        try { fitStage(); } catch (e) {}
        if (window.BaseMap && window.BaseMap.resize) window.BaseMap.resize();
        document.querySelectorAll('.chart-body').forEach(function (el) {
          var inst = window.echarts && window.echarts.getInstanceByDom && window.echarts.getInstanceByDom(el);
          if (inst) inst.resize();
        });
      }, 220);
    });
  }

  /* ---------------- 图层与全屏 ---------------- */
  function initExtras() {
    if (window.LayerFX) {
      try { window.LayerFX.init(); } catch (e) { console.warn('LayerFX', e); }
    }
    /* 主地图：高德原生（蓝色样式），缩放手感最好 */
    if (window.TerrainLayer) {
      try { window.TerrainLayer.setVisible(false); } catch (e) {}
    }
    if (window.HillShade) {
      try { window.HillShade.setVisible(false); } catch (e) {}
    }
    if (window.ChinaMap) {
      try { window.ChinaMap.setVisible(false); } catch (e) {}
    }

    var fs = document.getElementById('fsBtn');
    var hint = document.createElement('div');
    hint.className = 'fs-hint';
    hint.textContent = '点击任意处进入全屏';
    document.body.appendChild(hint);
    setTimeout(function () {
      if (!document.fullscreenElement) hint.classList.add('on');
    }, 1600);
    setTimeout(function () { hint.classList.remove('on'); }, 7000);

    function goFs() {
      var el = document.documentElement;
      if (el.requestFullscreen) {
        el.requestFullscreen().then(function () {
          hint.classList.remove('on');
        }).catch(function () {});
      }
    }
    var wb = document.getElementById('windBtn');
    if (wb) wb.addEventListener('click', function (e) {
      e.stopPropagation();
      var on = !wb.classList.contains('on');
      wb.classList.toggle('on', on);
      if (window.LayerFX) window.LayerFX.setMode(on ? 'wind' : 'aqi');
    });

    if (fs) fs.addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.fullscreenElement) document.exitFullscreen();
      else goFs();
    });

    /* 首次任意点击尝试全屏（浏览器要求用户手势） */
    var once = function () {
      if (!document.fullscreenElement) goFs();
      document.removeEventListener('pointerdown', once);
    };
    document.addEventListener('pointerdown', once);
  }

  /* ---------------- selection ---------------- */
  function selectCity(name, fly) {
    state.selected = name;
    var d = byName(name); if (!d) return;
    renderCityCard(d);
    /* 高德在用时，ECharts 只是兜底，别在每次选中都 notMerge 重建（掉帧元凶） */
    var usingAmap = !!(window.BaseMap && window.BaseMap.getMap && window.BaseMap.getMap());
    if (mapChart && !usingAmap) {
      mapChart.setOption(mapOption(fly ? { zoom: 3.6, center: [d.lng, d.lat] } : viewState()), { notMerge: false, lazyUpdate: true });
    }
    renderGauge();
    if (fly && usingAmap) flyToCity(name, { duration: 900 });
    $$('#cityTableBody tr').forEach(function (tr) { tr.classList.toggle('on', tr.dataset.name === name); });
  }

  function clearSelection() {
    state.selected = null;
    $('#cityCard').classList.remove('on');
    applyMapOption();
    renderGauge();
    $$('#cityTableBody tr').forEach(function (tr) { tr.classList.remove('on'); });
  }

  function renderCityCard(d) {
    var lv = window.AQ.levelOf(d.aqi);
    $('#ccName').childNodes[0].nodeValue = d.name;
    $('#ccProv').textContent = (d.province || '') + ' · ' + d.lng.toFixed(1) + 'E ' + d.lat.toFixed(1) + 'N';
    var a = $('#ccAqi'); countUp(a, 0, d.aqi, 520); a.style.color = lv.color;
    $('#ccLevel').textContent = lv.label + ' · AQI'; $('#ccLevel').style.color = lv.color;
    var cells = [['PM2.5', d.pm2_5, 'μg'], ['PM10', d.pm10, 'μg'], ['SO₂', d.sulphur_dioxide, 'μg'],
      ['NO₂', d.nitrogen_dioxide, 'μg'], ['O₃', d.ozone, 'μg'], ['首要', d.primary, '']];
    $('#ccGrid').innerHTML = cells.map(function (c) {
      var v = (typeof c[1] === 'number') ? fmt1(c[1]) : c[1];
      return '<div><span class="k">' + c[0] + '</span><span class="v">' + v + (c[2] ? '<i>' + c[2] + '</i>' : '') + '</span></div>';
    }).join('');
    $('#cityCard').classList.add('on');
  }

  /* ---------------- clock / dynamic ---------------- */
  function clock() {
    var d = new Date();
    $('#clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    var cd = $('#clockDate');
    if (cd) cd.textContent = d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) + '  ' + wd;
  }

  /* ---------------- 实时 API：自动轮询（不需要手动刷新） ---------------- */
  var liveTimer = null, liveCountdown = null, liveNextAt = 0;

  function liveInterval() {
    var ms = (window.MAP_CONFIG && window.MAP_CONFIG.liveRefreshMs) || 300000;
    return Math.max(60000, ms);
  }

  function liveTick() {
    var sw = $('#srcTabs button[data-src="realtime"]');
    if (sw) sw.classList.add('on');
    var btn = $('#fetchBtn');
    if (btn && btn.classList.contains('busy')) return;
    if (btn) { btn.classList.add('busy'); }
    window.AQ.fetchOpenMeteo(window.CITIES || [], function () {}).then(function (data) {
      if (btn) btn.classList.remove('busy');
      if (!data || !data.length) return;
      state.source = 'realtime';
      state.data = data;
      commit();
      $('#srcLabel').textContent = '实时 · 自动更新';
      $('#modeLabel').textContent = 'Open-Meteo Live Feed';
      liveNextAt = Date.now() + liveInterval();
    }).catch(function () { if (btn) btn.classList.remove('busy'); });
  }

  function startLive() {
    stopLive();
    liveNextAt = Date.now();
    liveTick();
    liveTimer = setInterval(liveTick, liveInterval());
    liveCountdown = setInterval(function () {
      var left = Math.max(0, liveNextAt - Date.now());
      var m = Math.floor(left / 60000), s2 = Math.floor(left % 60000 / 1000);
      var lab = $('#srcLabel');
      if (lab && state.source === 'realtime') lab.textContent = '实时 · ' + m + ':' + (s2 < 10 ? '0' : '') + s2;
    }, 1000);
  }
  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (liveCountdown) { clearInterval(liveCountdown); liveCountdown = null; }
  }

  /* 动态模式：仪表盘 / 环圈 / 柱状 / 24H 趋势 一起动 */
  function bindDynamics() {
    document.addEventListener('aq:tick', function () {
      try { renderGauge(); renderPie(); renderBar(); renderTrend(); } catch (e) {}
    });
    document.addEventListener('aq:update', function () {
      try { renderGauge(); renderPie(); renderBar(); renderTrend(); } catch (e) {}
    });
  }

  function startDynamic() {
    stopDynamic();
    state.timer = setInterval(function () { if (state.source === 'simulation') refresh(); }, 4200);
  }
  function stopDynamic() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  /* ---------------- bind ---------------- */
  function bind() {
    $('#srcTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-src]'); if (!btn) return;
      if (btn.dataset.src === 'excel') { $('#excelInput').click(); return; }
      if (btn.dataset.src === 'fetch') return;   // 由专用 handler 处理
      if (btn.dataset.src === 'realtime') { startLive(); return; }
      setSource(btn.dataset.src);
    });
    $('#excelInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      $('#srcLabel').textContent = 'PARSING';
      window.AQ.parseExcel(f).then(function (data) {
        state.source = 'excel'; syncSrc('excel');
        state.data = data; commit();
        $('#srcLabel').textContent = 'Excel 导入';
        $('#modeLabel').textContent = 'Excel Import';
      }).catch(function (err) { $('#srcLabel').textContent = '解析失败'; console.error(err); });
    });

    /* ---------- 地图城市搜索 ---------- */
    var msInput = $('#msInput'), msList = $('#msList');
    if (msInput && msList) {
      var msSel = -1, msItems = [];

      function lvColorOf(aqi) { return window.AQ.levelOf(aqi).color; }

      /* ---------------- 任意城市：本地没命中时联网解析 ---------------- */
  var onlineCache = {};

  function searchOnline(q) {
    if (!q || q.length < 2) {
      msList.innerHTML = '<div class="ms-empty">没有匹配的城市</div>';
      return;
    }
    if (!window.AMap) {
      msList.innerHTML = '<div class="ms-empty">没有匹配的城市</div>';
      return;
    }
    /* DistrictSearch 是插件，按需加载后再查 */
    if (!AMap.DistrictSearch) {
      AMap.plugin('AMap.DistrictSearch', function () { searchOnline(q); });
      return;
    }
    var ds = new AMap.DistrictSearch({ level: 'city', subdistrict: 0, extensions: 'base' });
    ds.search(q, function (status, result) {
      var d = result && result.districtList && result.districtList[0];
      if (status !== 'complete' || !d || !d.center) {
        msList.innerHTML = '<div class="ms-empty">未找到该城市，试试全名（如 毕节市）</div>';
        return;
      }
      var name = d.name.replace(/(市|地区|自治州|盟)$/, '');
      var lng = d.center.getLng ? d.center.getLng() : d.center.lng;
      var lat = d.center.getLat ? d.center.getLat() : d.center.lat;
      var key = lng.toFixed(2) + ',' + lat.toFixed(2);

      var render = function (aqi, extra) {
        msItems = [{ name: name, province: '在线数据', aqi: aqi, lng: lng, lat: lat, online: true }];
        msSel = 0;
        msList.innerHTML = '<li data-i="0">' +
          '<span class="ms-n">' + name + ' <i class="ms-badge">在线</i></span>' +
          '<span class="ms-p">Open-Meteo' + (extra ? ' · ' + extra : '') + '</span>' +
          '<span class="ms-a" style="color:' + lvColorOf(aqi) + '">' + aqi + '</span>' +
          '</li>';
        msList.hidden = false;
      };

      if (onlineCache[key]) { render(onlineCache[key]); return; }
      render('…');
      var url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat +
        '&longitude=' + lng + '&current=pm2_5,pm10,sulphur_dioxide,nitrogen_dioxide,ozone,us_aqi';
      fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        var c = (j && j.current) || {};
        var aqi = Math.round(c.us_aqi || 0);
        if (!aqi) aqi = Math.max(1, Math.min(500, Math.round((c.pm2_5 || 10) * 3.2)));
        onlineCache[key] = aqi;
        render(aqi, '美标');
        msItems[0].pm = c;
      }).catch(function () { render('--'); });
    });
  }

  function renderMs(q) {
        q = (q || '').trim();
        var d = state.data.slice();
        if (q) {
          d = d.filter(function (c) {
            return c.name.indexOf(q) >= 0 || (c.province || '').indexOf(q) >= 0;
          });
        } else {
          d = d.slice().sort(function (a, b) { return b.aqi - a.aqi; }).slice(0, 8);
        }
        d = d.slice(0, 10);
        msItems = d;
        msSel = -1;
        if (!d.length) {
          msList.innerHTML = '<div class="ms-empty">没有匹配的城市，正在联网查…</div>';
      searchOnline(q);
        } else {
          msList.innerHTML = d.map(function (c, i) {
            return '<li data-i="' + i + '">' +
              '<span class="ms-n">' + c.name + '</span>' +
              '<span class="ms-p">' + (c.province || '') + '</span>' +
              '<span class="ms-a" style="color:' + lvColorOf(c.aqi) + '">' + c.aqi + '</span>' +
              '</li>';
          }).join('');
        }
        msList.hidden = false;

        /* 防抖 280ms 后唯一命中才飞，避免每敲一个字就飞一次 */
        if (q && d.length === 1) {
          var only = d[0];
          if (q === only.name || q === only.province) {
            clearTimeout(renderMs._t);
            renderMs._t = setTimeout(function () { pick(0); }, 280);
          }
        }
      }

      function pick(i) {
        var c = msItems[i];
        if (!c) return;
        msList.hidden = true;
        msInput.value = c.name;
        selectCity(c.name, true);
        try { document.dispatchEvent(new CustomEvent('drill:city', { detail: c.name })); } catch (e) {}
      }

      msInput.addEventListener('focus', function () { renderMs(msInput.value); });
      var msTyping = null;
      msInput.addEventListener('input', function () {
        clearTimeout(msTyping);
        var st = document.getElementById('msState');
        if (st) { st.textContent = '输入中…'; st.classList.add('on'); }
        msTyping = setTimeout(function () {
          renderMs(msInput.value);
          if (st && msList.hidden) st.classList.remove('on');
        }, 280);
      });
      msInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { msList.hidden = true; msInput.blur(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (msList.hidden) renderMs(msInput.value);
          var n = msItems.length;
          if (!n) return;
          msSel = (msSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
          Array.prototype.forEach.call(msList.querySelectorAll('li'), function (li, i) {
            li.classList.toggle('on', i === msSel);
          });
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          pick(msSel >= 0 ? msSel : 0);
        }
      });
      msList.addEventListener('mousedown', function (e) {
        var li = e.target.closest('li');
        if (!li) return;
        e.preventDefault();
        pick(+li.dataset.i);
      });
      document.addEventListener('mousedown', function (e) {
        if (!e.target.closest('#mapSearch')) msList.hidden = true;
      });
    }


    /* 面板收起 */
    var pToggle = $('#panelToggle');
    function togglePanels() {
      document.getElementById('stage').classList.toggle('panel-hidden');
      if (mapChart) setTimeout(function () { mapChart.resize(); }, 240);
    }
    if (pToggle) pToggle.addEventListener('click', togglePanels);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'p' || e.key === 'P') {
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        togglePanels();
      }
    });


    /* ---------- 面板心跳点 + 重叠自检 ---------- */
    (function () {
      /* 每块面板标题右侧一个 1s 闪一次的小点 */
      $$('.panel .p-head').forEach(function (h) {
        if (h.querySelector('.pulse')) return;
        var d = document.createElement('i');
        d.className = 'pulse';
        h.appendChild(d);
      });

      /* data-region 标记 + 两两相交检测（挂到 window.__overlapReport） */
      function regionOf(el) {
        if (el.classList.contains('left-col')) return 'left';
        if (el.classList.contains('side-col')) return 'right';
        if (el.classList.contains('kpi-strip')) return 'top';
        if (el.classList.contains('chart-row')) return 'bottom';
        if (el.classList.contains('hud-bottom')) return 'bottom';
        if (el.classList.contains('map-stage')) return 'center';
        return null;
      }
      function mark() {
        $$('.left-col, .side-col, .kpi-strip, .chart-row, .hud-bottom, .casc-list, .casc-stats, .casc-bar')
          .forEach(function (el) {
            var r = regionOf(el) || (el.classList.contains('casc-list') ? 'left'
              : el.classList.contains('casc-stats') ? 'right'
              : el.classList.contains('casc-bar') ? 'top' : 'center');
            el.setAttribute('data-region', r);
          });
      }
      function overlapArea(a, b) {
        var x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        var y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return x * y;
      }
      window.__checkOverlap = function () {
        mark();
        var els = $$('[data-region]').filter(function (e) { return e.offsetParent !== null; });
        var rep = [];
        for (var i = 0; i < els.length; i++) {
          for (var j = i + 1; j < els.length; j++) {
            var A = els[i].getBoundingClientRect(), Bb = els[j].getBoundingClientRect();
            if (!A.width || !Bb.width) continue;
            var ar = overlapArea(A, Bb);
            if (ar > 4) {
              rep.push({
                a: els[i].id || els[i].className, b: els[j].id || els[j].className, area: Math.round(ar)
              });
            }
          }
        }
        window.__overlapReport = rep;
        if (rep.length) console.warn('[overlap]', rep);
        return rep;
      };
      setTimeout(window.__checkOverlap, 2500);
    })();

    /* 省份一览：做成侧边栏里的一个按钮，点开收起 */
    (function moveCascList() {
      var list = document.querySelector('.casc-list');
      var sb = document.getElementById('sidebar');
      if (!list || !sb) return;

      var box = document.createElement('div');
      box.className = 'sb-casc-box';
      box.id = 'sbCascBox';
      list.parentNode && list.parentNode.removeChild(list);
      box.appendChild(list);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sb-casc-toggle';
      btn.id = 'sbCascToggle';
      btn.innerHTML = '<i>▤</i><span>省份一览</span><b id="sbCascNum"></b><em>▾</em>';
      btn.addEventListener('click', function () {
        box.classList.toggle('open');
        btn.classList.toggle('on', box.classList.contains('open'));
      });

      sb.appendChild(btn);
      sb.appendChild(box);
    })();

    initExtras();
    bindDynamics();
    bindFullscreenRefit();
    $('#refreshBtn').addEventListener('click', function () { refresh(true); });

    /* 抓取实时数据（Open-Meteo，浏览器直连） */
    var fetchBtn = $('#fetchBtn');
    if (fetchBtn) {
      fetchBtn.addEventListener('click', function () {
        if (fetchBtn.classList.contains('busy')) return;
        fetchBtn.classList.add('busy');
        var oldTxt = fetchBtn.textContent;
        fetchBtn.textContent = '抓取中 0%';
        window.AQ.fetchOpenMeteo(window.CITIES || [], function (done, total) {
          fetchBtn.textContent = '抓取中 ' + Math.round(done / total * 100) + '%';
        }).then(function (data) {
          fetchBtn.classList.remove('busy');
          fetchBtn.textContent = oldTxt;
          if (!data || !data.length) { $('#srcLabel').textContent = '抓取失败'; return; }
          state.source = 'realtime';
          state.dynamic = false;
          $('#dynBtn').classList.remove('on');
          stopDynamic();
          state.data = data;
          commit();
          syncSrc('fetch');
          $('#srcLabel').textContent = '实时数据';
          $('#modeLabel').textContent = 'Open-Meteo Live Feed';
          try { localStorage.setItem('aq_realtime', JSON.stringify({ t: Date.now(), data: data })); } catch (e) {}
        }).catch(function (err) {
          fetchBtn.classList.remove('busy');
          fetchBtn.textContent = oldTxt;
          $('#srcLabel').textContent = '抓取失败';
          console.error(err);
        });
      });
    }

    /* 导出 Excel */
    var exportBtn = $('#exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        if (window.AQ.exportExcel) window.AQ.exportExcel(state.data);
      });
    }

    /* 天气 + 实时 PM2.5（顶部右侧） */
    if (window.AQ.fetchWeather) {
      window.AQ.fetchWeather().then(function (w) {
        if (!w) return;
        var t = $('#wxTemp'), pm = $('#hudPm'), ic = $('#wxIcon');
        if (t) t.textContent = Math.round(w.temp);
        if (pm) pm.textContent = Math.round(w.pm25);
        if (ic) ic.textContent = w.icon;
      }).catch(function () {});
    }

    /* 全国总览 / 三级联动 */
    var modeSw = $('#modeSwitch');
    if (modeSw) {
      modeSw.addEventListener('click', function (e) {
        var btn = e.target.closest('button'); if (!btn) return;
        $$('button', modeSw).forEach(function (b) { b.classList.toggle('on', b === btn); });
        var mode = btn.dataset.mode;
        var stage = document.getElementById('stage');
        if (stage) {
          stage.classList.toggle('cascade-on', mode === 'cascade');
          stage.classList.toggle('city3d-on', mode === 'city3d');
        }
        if (mode === 'cascade') {
          if (window.Cascade) window.Cascade.setMode('cascade');
        } else {
          if (window.Cascade) window.Cascade.setMode('nation');
          if (mapChart) setTimeout(function () { mapChart.resize(); }, 30);
        }
      });
    }

    /* 底图切换：矢量 / 高德 / 百度 */
    var baseTabs = $('#baseTabs');
    if (baseTabs) {
      baseTabs.addEventListener('click', function (e) {
        var btn = e.target.closest('.tab'); if (!btn) return;
        var p = btn.dataset.map;
        if (!window.BaseMap) return;
        var ok = window.BaseMap.setProvider(p);
        if (ok === false) return;              // 缺 Key 时保持原选中
        $$('.tab', baseTabs).forEach(function (b) { b.classList.toggle('on', b === btn); });
        if (p !== 'vector') window.BaseMap.update(state.data, state.metric, colorOf);
      });
    }
    $('#dynBtn').addEventListener('click', function () {
      state.dynamic = !state.dynamic;
      this.classList.toggle('on', state.dynamic);
      if (state.dynamic) startDynamic(); else stopDynamic();
    });
    $('#metricTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.tab'); if (!btn) return;
      $$('.tab', $('#metricTabs')).forEach(function (b) { b.classList.toggle('on', b === btn); });
      state.metric = btn.dataset.metric;
      renderMap(); renderTrend();
    });
    /* 城市搜索：边打边筛表格；只剩一个命中就直接飞过去；回车跳到第一条 */
    var citySearch = $('#citySearch');
    citySearch.addEventListener('input', function (e) {
      state.query = e.target.value;
      renderTable();
      var rows = tableRows();
      if (state.query.trim() && rows.length === 1) selectCity(rows[0].name, true);
    });
    citySearch.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var rows = tableRows();
      if (rows.length) selectCity(rows[0].name, true);
    });
    citySearch.addEventListener('search', function (e) { state.query = e.target.value || ''; renderTable(); });
    $('#sortSelect').addEventListener('change', function (e) { state.sortKey = e.target.value; renderTable(); });
    $('#ccClose').addEventListener('click', clearSelection);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') clearSelection(); });
    window.addEventListener('resize', fitStage);
  }

  function setSource(src) {
    state.source = src; syncSrc(src);
    if (src !== 'realtime') stopLive();
    if (src === 'realtime') {
      $('#modeLabel').textContent = 'Open-Meteo Live Feed';
      refresh();
    } else {
      $('#modeLabel').textContent = 'Simulation Feed';
      $('#srcLabel').textContent = '仿真数据';
      refresh();
    }
  }
  function syncSrc(src) {
    $$('#srcTabs button[data-src]').forEach(function (b) { b.classList.toggle('on', b.dataset.src === src); });
  }

  /* 供 AI 面板调用 */
  window.AQApp = {
    data: function () { return state.data; },
    summary: function () { return state.summary; },
    city: byName,
    select: selectCity,
    metric: function () { return state.metric; }
  };

  /* ---------------- boot ---------------- */
  function boot() {
    fitStage();
    bind();
    clock();
    if (!STATIC) setInterval(clock, 1000);
    registerMap();
    var cached = null;
    try {
      var raw = localStorage.getItem('aq_realtime');
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.data && o.data.length && Date.now() - o.t < 6 * 3600 * 1000) cached = o.data;
      }
    } catch (e) {}
    state.data = cached || window.AQ.simulate(0);
    if (cached) { state.source = 'realtime'; setTimeout(function () { syncSrc('fetch'); $('#srcLabel').textContent = '实时数据'; }, 0); }
    commit();
    /* 底图自动选择：有 Key 就用高德/百度，没有就矢量，无需手动切换 */
    if (window.BaseMap) {
      window.BaseMap.setProvider((window.MAP_CONFIG && window.MAP_CONFIG.provider) || 'auto');
    }
    if (!STATIC && state.dynamic) startDynamic();
    setTimeout(fitStage, 60);
    (function(){
      var def = (window.MAP_CONFIG && window.MAP_CONFIG.defaultMode) || 'nation';
      if (def === 'cascade' || /mode=cascade/.test(location.search)) {
        setTimeout(function () {
          var sw = document.querySelector('#modeSwitch button[data-mode=cascade]');
          if (sw) sw.click();
        }, 90);
      }
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
