/* ============================================================================
   features.js —— 功能侧边栏（单一数据源驱动）
   · 侧边栏 / 快捷键 / 功能清单 / 持久化 都读同一份 FEATURES
   · kind: view（切视图） / toggle（开关） / action（执行）
   · 面板默认收起，点的项自动把对应面板拉出来
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var ONLY_GROUP = 'analytics';   /* 只保留「分析」组 */

  var GROUPS = [
    { id: 'data', name: '数据源', en: 'DATA' },
    { id: 'view', name: '视图', en: 'VIEW' },
    { id: 'fx', name: '特效', en: 'EFFECTS' },
    { id: 'analytics', name: '分析', en: 'ANALYTICS' },
    { id: 'asset', name: '资产', en: 'ASSETS' }
  ];

  /* ---------------- 单一数据源 ---------------- */
  var FEATURES = [
    /* --- data --- */
    { id: 'data.sim', group: 'data', label: '仿真数据', desc: '一次性：本地生成的演示数据', icon: '◈', kind: 'action',
      run: function () { clickSrc('simulation'); } },
    { id: 'data.live', group: 'data', label: '实时 API', desc: '自动轮询，每 5 分钟刷新一次', icon: '◉', kind: 'action',
      run: function () { clickSrc('realtime'); } },
    { id: 'data.fetch', group: 'data', label: '抓取实时数据', desc: '一次性：90 城并发抓取，带进度', icon: '⟳', kind: 'action',
      run: function () { var b = $('#fetchBtn'); if (b) b.click(); } },
    { id: 'data.import', group: 'data', label: '导入 Excel', desc: '从本地表格读入数据', icon: '⬆', kind: 'action',
      run: function () { var i = $('#excelInput'); if (i) i.click(); } },
    { id: 'data.export', group: 'data', label: '导出 Excel', desc: '把当前数据存成 xlsx', icon: '⬇', kind: 'action',
      run: function () { var b = $('#exportBtn'); if (b) b.click(); } },

    /* --- view --- */
    { id: 'view.nation', group: 'view', label: '回到全国', desc: '回到全国省份一览，退出城市视图', icon: '🗺', kind: 'view',
      run: function () { goView('nation'); } },
    { id: 'view.3d', group: 'view', label: '3D 城市', desc: '切到发光楼体 + 巡航镜头', icon: '⬢', kind: 'view',
      run: function () { goView('city3d'); } },

    /* --- fx --- */
    { id: 'fx.dots', group: 'fx', label: '城市光点', desc: '地图上的 AQI 光点', icon: '●', kind: 'toggle', defaultOn: true,
      set: function (on) { bm('setMarkers', on); } },
    { id: 'fx.heat', group: 'fx', label: '热区气泡', desc: '最脏 12 城的热区圆', icon: '◎', kind: 'toggle', defaultOn: true,
      set: function (on) { bm('setHeat', on); } },
    { id: 'fx.scan', group: 'fx', label: '扫描层', desc: '整屏扫描线与颗粒', icon: '▤', kind: 'toggle', defaultOn: true,
      set: function (on) {
        $$('.layer-scan, .layer-sweep, .layer-grid').forEach(function (e) { e.style.display = on ? '' : 'none'; });
      } },
    { id: 'fx.tilt', group: 'fx', label: '3D 抬头', desc: '放大时自动抬头看楼块', icon: '◭', kind: 'toggle', defaultOn: true,
      set: function (on) { window.__aqTilt = on; } },
    { id: 'fx.tour', group: 'fx', label: '巡航', desc: '3D 持续放大运镜', icon: '⏵', kind: 'toggle', defaultOn: true,
      set: function (on) {
        if (!window.City3D) return;
        if (on) window.City3D.startTour(); else window.City3D.stopTour();
      } },

    /* --- analytics --- */
    { id: 'an.level', group: 'analytics', label: '等级分布', desc: '六档占比条 + 图例', icon: '▥', kind: 'toggle', panel: 'panelLevel' },
    { id: 'an.gauge', group: 'analytics', label: 'AQI 仪表盘', desc: '当前范围 AQI 表盘', icon: '◔', kind: 'toggle', panel: 'panelGauge' },
    { id: 'an.pie', group: 'analytics', label: '等级环形', desc: '等级数量占比', icon: '◕', kind: 'toggle', panel: 'panelPie' },
    { id: 'an.bar', group: 'analytics', label: '污染物柱状', desc: '五项平均浓度', icon: '▮', kind: 'toggle', panel: 'panelBar' },
    { id: 'an.trend', group: 'analytics', label: '24h 趋势', desc: '24 小时浓度曲线', icon: '〜', kind: 'toggle', panel: 'panelTrend' },
    { id: 'an.ai', group: 'analytics', label: 'AI 问答', desc: '问数据、问成因', icon: '✦', kind: 'toggle', panel: 'panelAI', defaultOn: true },
    { id: 'an.best', group: 'analytics', label: '最佳榜', desc: '空气最好的 7 城', icon: '↑', kind: 'toggle', panel: 'panelBest', defaultOn: true },
    { id: 'an.worst', group: 'analytics', label: '最差榜', desc: '污染最重的 7 城', icon: '↓', kind: 'toggle', panel: 'panelWorst', defaultOn: true },
    { id: 'an.table', group: 'analytics', label: '城市明细表', desc: '全量可搜索排序', icon: '▤', kind: 'toggle', panel: 'panelTable' },
    { id: 'fx.wind', group: 'analytics', label: '风场', desc: '全球风流线，点一下开关', icon: '≋', kind: 'toggle', action: 'wind', defaultOn: false },
    { id: 'an.region', group: 'analytics', label: '区域指标', desc: '当前范围单位数/均值/极值', icon: '▣', kind: 'toggle', panel: 'cascStats', defaultOn: false },

    /* --- asset --- */
  ];

  /* ---------------- 工具 ---------------- */
  function bm(fn, on) { try { if (window.BaseMap && window.BaseMap[fn]) window.BaseMap[fn](on); } catch (e) {} }
  function clickSrc(src) {
    var b = $('#srcTabs button[data-src="' + src + '"]');
    if (b) b.click();
  }
  function goView(v) {
    if (!window.Cascade || !window.Cascade.setMode) return;
    window.Cascade.setMode(v === 'nation' ? 'nation' : (v === 'city3d' ? 'city3d' : 'cascade'));
  }
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'sb-toast';
      document.getElementById('stage').appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    collapsed: false,
    toggles: {},
    activeView: 'nation',
    query: '',
    cursor: -1
  };

  function load() {
    try {
      var raw = localStorage.getItem('aq_features');
      if (raw) {
        var o = JSON.parse(raw);
        state.collapsed = !!o.collapsed;
        state.toggles = o.toggles || {};
        state.activeView = o.activeView || 'nation';
      }
    } catch (e) {}
    FEATURES.forEach(function (f) {
      if (f.kind === 'toggle' && state.toggles[f.id] === undefined) {
        state.toggles[f.id] = f.defaultOn === true;
      }
    });
  }
  function save() {
    try {
      localStorage.setItem('aq_features', JSON.stringify({
        collapsed: state.collapsed, toggles: state.toggles, activeView: state.activeView
      }));
    } catch (e) {}
  }

  /* ---------------- 面板显隐 ---------------- */
  function applyPanels() {
    var anyChart = false, anySide = false;
    FEATURES.forEach(function (f) {
      if (f.kind !== 'toggle' || !f.panel) return;
      var el = document.getElementById(f.panel);
      if (!el) return;
      var on = state.toggles[f.id] !== false;
      el.classList.toggle('panel-off', !on);
      el.hidden = !on;
      if (on && /panelGauge|panelPie|panelBar|panelTrend|panelTable/.test(f.panel)) anyChart = true;
      if (on && /panelLevel|panelAI|panelBest|panelWorst/.test(f.panel)) anySide = true;
    });
    var stage = document.getElementById('stage');
    stage.classList.toggle('no-charts', !anyChart);
    stage.classList.toggle('no-left', false);
    setTimeout(function () {
      if (window.AQApp && window.AQApp.resize) window.AQApp.resize();
      ['gaugeChart', 'pieChart', 'barChart', 'trendChart'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && window.echarts && el.__chart) el.__chart.resize();
      });
      window.dispatchEvent(new Event('resize'));
    }, 220);
    return anyChart;
  }

  /* ---------------- 渲染 ---------------- */
  function renderSidebar() {
    var body = $('#sbBody');
    if (!body) return;
    var q = state.query.trim();
    var html = '';
    GROUPS.forEach(function (g) {
      var items = FEATURES.filter(function (f) {
        if (f.group !== g.id) return false;
        if (ONLY_GROUP && g.id !== ONLY_GROUP) return false;
        if (f.status && f.status() === 'off') return false;   /* 点不了的直接不渲染 */
        if (!q) return true;
        return (f.label + f.desc).indexOf(q) >= 0;
      });
      if (!items.length) return;
      if (ONLY_GROUP && g.id !== ONLY_GROUP) return;
      html += '<div class="sb-group"><div class="sb-gtitle">' + g.name + '<i>' + g.en + '</i></div>';
      items.forEach(function (f) {
        var on = f.kind === 'toggle' ? (state.toggles[f.id] !== false) : (f.kind === 'view' ? state.activeView === viewKey(f) : true);
        var st = f.status ? f.status() : null;
        var off = st === 'off';
        html += '<button class="sb-item' + (on ? ' on' : '') + (off ? ' off' : '') +
          '" data-id="' + f.id + '" title="' + f.desc + '">' +
          '<span class="sb-ico">' + f.icon + '</span>' +
          '<span class="sb-txt"><b>' + f.label + '</b><i>' + f.desc + '</i></span>' +
          '<span class="sb-dot"></span></button>';
      });
      html += '</div>';
    });
    body.innerHTML = html || '<div class="sb-empty">没有匹配的功能</div>';

    $$('.sb-item', body).forEach(function (btn) {
      btn.addEventListener('click', function () { activate(btn.dataset.id); });
    });
  }

  function viewKey(f) {
    if (f.id === 'view.nation') return 'nation';
    if (f.id === 'view.district') return 'cascade';
    return 'city3d';
  }

  function activate(id) {
    var f = FEATURES.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    if (f.kind === 'view') {
      state.activeView = viewKey(f);
      if (f.run) f.run();
      toast('已切换 · ' + f.label);
    } else if (f.kind === 'toggle') {
      var on;
      if (f.action === 'wind' && window.WindLayer) {
        on = !window.WindLayer.isOn();       /* 以图层真实状态为准 */
      } else {
        on = !(state.toggles[f.id] !== false);
      }
      state.toggles[f.id] = on;
      if (f.panel) applyPanels();
      else if (f.set) f.set(on);
      if (f.action === 'wind') {
        if (window.LayerFX) window.LayerFX.setMode(on ? 'wind' : 'aqi');
        var wb = document.getElementById('windBtn');
        if (wb) wb.classList.toggle('on', on);
      }
      toast((on ? '已开启 · ' : '已关闭 · ') + f.label);
    } else {
      if (f.run) f.run();
      toast(f.label);
    }
    save();
    renderSidebar();
  }

  /* ---------------- 应用初始特效状态 ---------------- */
  function applyAllFx() {
    FEATURES.forEach(function (f) {
      if (f.kind !== 'toggle' || f.panel) return;
      var on = state.toggles[f.id] !== false;
      if (f.set) { try { f.set(on); } catch (e) {} }
    });
  }

  /* ---------------- 功能清单 ---------------- */
  function renderInventory() {
    var tb = $('#invBody');
    if (!tb) return;
    var rows = FEATURES.map(function (f) {
      var g = GROUPS.filter(function (x) { return x.id === f.group; })[0];
      var on = f.kind === 'toggle' ? (state.toggles[f.id] !== false)
        : (f.kind === 'view' ? state.activeView === viewKey(f) : true);
      var st = f.status ? f.status() : null;
      return '<tr><td>' + (g ? g.name : f.group) + '</td><td>' + f.label + '</td><td>' + f.desc +
        '</td><td>' + f.kind + '</td><td>' + (f.shortcut || '—') + '</td><td>' +
        (st === 'off' ? '<i class="no">未配置</i>' : (on ? '<i class="yes">开</i>' : '<i class="no">关</i>')) +
        '</td><td>' + (f.requires || '—') + '</td></tr>';
    }).join('');
    tb.innerHTML = rows;
    var cnt = FEATURES.filter(function (f) {
      return f.kind !== 'toggle' || state.toggles[f.id] !== false;
    }).length;
    $('#invCount').textContent = '共 ' + FEATURES.length + ' 项，已启用 ' + cnt + ' 项';
  }

  /* ---------------- 键盘 ---------------- */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea';
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        var idx = +e.key - 1;
        if (FEATURES[idx]) { e.preventDefault(); activate(FEATURES[idx].id); }
        return;
      }
      if (typing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var items = $$('.sb-item');
        if (!items.length) return;
      if (ONLY_GROUP && g.id !== ONLY_GROUP) return;
        e.preventDefault();
        state.cursor = (state.cursor + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach(function (b, i) { b.classList.toggle('cur', i === state.cursor); });
        return;
      }
      if (e.key === 'Enter' && state.cursor >= 0) {
        var it = $$('.sb-item')[state.cursor];
        if (it) it.click();
      }
    });
  }


  /* ---------------- 侧边栏宽度：拖拽 / 记忆 / 复位 / 键盘 ---------------- */
  var SB_KEY = 'aq_sb_width';
  var sbW = 280;

  function applyW(w) {
    sbW = Math.max(200, Math.min(420, Math.round(w)));
    var stage = document.getElementById('stage');
    if (stage) stage.style.setProperty('--sb-w', sbW + 'px');
    var sb = document.getElementById('sidebar');
    if (sb) {
      sb.classList.toggle('narrow', sbW < 240);
      sb.classList.toggle('wide', sbW > 360);
    }
  }

  function persistW() {
    try { localStorage.setItem(SB_KEY, String(sbW)); } catch (e) {}
    if (window.BaseMap && window.BaseMap.resize) window.BaseMap.resize();
    window.dispatchEvent(new Event('resize'));
    setTimeout(function () {
      if (window.featuresChartsResize) window.featuresChartsResize();
      document.querySelectorAll('.chart-body').forEach(function (el) {
        var inst = window.echarts && window.echarts.getInstanceByDom && window.echarts.getInstanceByDom(el);
        if (inst) inst.resize();
      });
    }, 60);
  }

  function bindResizer() {
    var stage = document.getElementById('stage');
    var rz = document.getElementById('sbResizer');
    if (!stage || !rz) return;

    try {
      var saved = parseInt(localStorage.getItem(SB_KEY) || '', 10);
      if (saved >= 200 && saved <= 420) applyW(saved);
    } catch (e) {}

    var dragging = false, startX = 0, startW = 0, raf = 0, pending = 0;

    rz.addEventListener('pointerdown', function (e) {
      if (stage.getAttribute('data-sidebar') === 'collapsed') return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startW = sbW;
      rz.classList.add('dragging');
      document.body.classList.add('resizing');
      try { rz.setPointerCapture(e.pointerId); } catch (err) {}
    });

    rz.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      pending = startW + (e.clientX - startX);
      if (!raf) {
        raf = requestAnimationFrame(function () {
          raf = 0;
          applyW(pending);
        });
      }
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      rz.classList.remove('dragging');
      document.body.classList.remove('resizing');
      persistW();
    }
    rz.addEventListener('pointerup', endDrag);
    rz.addEventListener('pointercancel', endDrag);

    rz.addEventListener('dblclick', function () { applyW(280); persistW(); });

    rz.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { applyW(sbW - 8); persistW(); e.preventDefault(); }
      if (e.key === 'ArrowRight') { applyW(sbW + 8); persistW(); e.preventDefault(); }
    });
    rz.tabIndex = 0;
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (!$('#sidebar')) return;
    load();
    renderSidebar();
    applyPanels();
    bindKeys();

    bindResizer();
    $('#sbCollapse').addEventListener('click', function () {
      state.collapsed = !state.collapsed;
      document.getElementById('stage').setAttribute('data-sidebar', state.collapsed ? 'collapsed' : 'open');
      save();
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 220);
    });
    document.getElementById('stage').setAttribute('data-sidebar', state.collapsed ? 'collapsed' : 'open');

    var search = $('#sbSearch');
    search.addEventListener('input', function () { state.query = search.value; state.cursor = -1; renderSidebar(); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { search.value = ''; state.query = ''; search.blur(); renderSidebar(); }
    });

    $('#sbInventory').addEventListener('click', function () {
      renderInventory();
      $('#invMask').hidden = false;
    });
    $('#invClose').addEventListener('click', function () { $('#invMask').hidden = true; });
    $('#invMask').addEventListener('click', function (e) { if (e.target.id === 'invMask') $('#invMask').hidden = true; });
    $('#sbKeys').addEventListener('click', function () {
      toast('Alt+1~9 直达 · ↑↓ 选择 · Enter 执行 · Esc 关闭 · P 收起面板');
    });
    if (/inventory=1/.test(location.search)) { renderInventory(); $('#invMask').hidden = false; }

    /* 底图就绪后再套一次特效开关 */
    setTimeout(applyAllFx, 1800);
    setTimeout(applyAllFx, 4200);
  }

  window.Features = { list: FEATURES, state: state, activate: activate, toast: toast, applyPanels: applyPanels,
    setWidth: function (w) { applyW(w); persistW(); }, sbWidth: function () { return sbW; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 500); });
  else setTimeout(boot, 500);
})();
