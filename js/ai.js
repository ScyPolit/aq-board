/* ============================================================================
   AI 数据问答（本地规则引擎，离线可用）
   支持：城市查询 / 双城对比 / 最重最轻 / 优良率 / 首要污染物 / 污染物排名 / 健康建议
   ========================================================================== */
(function () {
  'use strict';

  var log, form, input, ready = false;

  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  function push(role, html) {
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<span class="who">' + (role === 'user' ? 'YOU' : 'DATA ASSISTANT') + '</span>' + html;
    log.appendChild(div);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function num(v) { return '<span class="num">' + v + '</span>'; }
  function chip(d) { return '<span class="citychip" data-city="' + d.name + '">' + d.name + '</span>'; }
  function lvOf(d) { return window.AQ.levelOf(d.aqi); }
  function colorLv(d) { return '<b style="color:' + lvOf(d).color + '">' + d.aqi + '</b>'; }

  function list(rows) {
    return '<ul>' + rows.map(function (r) { return '<li><span>' + r[0] + '</span><span>' + r[1] + '</span></li>'; }).join('') + '</ul>';
  }

  function topBy(key, n) {
    var d = window.AQApp.data().slice();
    d.sort(function (a, b) { return (b[key] || 0) - (a[key] || 0); });
    return d.slice(0, n);
  }

  /* ---------------- 成因知识库 ---------------- */
  var INDUSTRIAL = ['石家庄','唐山','邯郸','太原','大同','包头','鞍山','淄博','武汉','洛阳','西安','兰州',
    '石嘴山','乌鲁木齐','克拉玛依','天津','济南','郑州','徐州','无锡','株洲'];
  var DUSTY = ['乌鲁木齐','克拉玛依','喀什','巴彦淖尔','乌兰察布','银川','石嘴山','中卫','吴忠','兰州','西宁','包头','鄂尔多斯'];
  var COASTAL = ['大连','烟台','青岛','厦门','深圳','珠海','三亚','海口','宁波','温州','泉州','舟山'];
  var NORTH = ['北京','天津','石家庄','太原','呼和浩特','沈阳','长春','哈尔滨','济南','郑州','西安','兰州','银川','西宁','乌鲁木齐'];

  var CAUSE_TEXT = {
    'PM2.5': {
      why: '细颗粒物主要来自<b>燃煤与工业排放</b>、机动车尾气、以及大气中二氧化硫/氮氧化物二次转化生成的气溶胶。',
      keep: '静稳少风、逆温层低的天气会让它在近地面持续累积，所以冬季和夜间往往最重。'
    },
    'PM10': {
      why: '可吸入颗粒物以<b>扬尘</b>为主：建筑工地、道路扬尘、裸露地表，以及沙尘天气的区域传输。',
      keep: '大风天沙尘输送明显，粗颗粒沉降快，浓度往往来得猛、退得也快。'
    },
    'SO₂': {
      why: '二氧化硫几乎全部来自<b>含硫燃煤</b>：燃煤电厂、工业锅炉、冬季集中供热。',
      keep: '北方采暖季浓度抬升最明显，脱硫改造到位的城市通常已降到很低水平。'
    },
    'NO₂': {
      why: '二氧化氮主要来自<b>机动车尾气</b>（尤其柴油货车）与工业窑炉，早晚高峰特征明显。',
      keep: '路口、高架、港口物流区周边浓度明显高于背景值。'
    },
    'O₃': {
      why: '臭氧不是直接排放，而是氮氧化物和挥发性有机物在<b>强日照、高温</b>下发生光化学反应生成的二次污染。',
      keep: '所以臭氧污染多出现在晴朗的午后（12–17 时），夜间反而下降。'
    }
  };

  function causeAnalysis(ds) {
    var s = window.AQApp.summary();
    var d = (ds && ds[0]) || s.worst || null;
    var national = !d;
    var ia = d ? (d.iaqis || []) : window.AQ.calcChinaAQI({
      pm2_5: s.avg.pm2_5, pm10: s.avg.pm10, sulphur_dioxide: s.avg.so2,
      nitrogen_dioxide: s.avg.no2, ozone: s.avg.o3
    }).iaqis;
    ia = ia.slice().sort(function (a, b) { return b.val - a.val; });
    var top = ia[0] || { name: 'PM2.5', val: 0 };
    var txt = CAUSE_TEXT[top.name] || CAUSE_TEXT['PM2.5'];

    var where = national ? '全国整体' : d.name;
    var lv = national ? window.AQ.levelOf(s.avgAqi) : window.AQ.levelOf(d.aqi);
    var val = national ? s.avgAqi : d.aqi;

    var extra = [];
    if (d) {
      if (INDUSTRIAL.indexOf(d.name) >= 0) extra.push('<b>产业结构</b>：' + d.name + ' 属于重化工/钢铁/建材类城市，工业与燃煤排放基数偏大。');
      if (DUSTY.indexOf(d.name) >= 0) extra.push('<b>地理条件</b>：地处西北干旱区，<b>沙尘与扬尘</b>贡献显著。');
      if (COASTAL.indexOf(d.name) >= 0) extra.push('<b>扩散条件</b>：沿海城市海风与降水较多，污染物易于扩散和沉降。');
      if (NORTH.indexOf(d.name) >= 0) extra.push('<b>季节性</b>：北方城市冬季采暖会额外增加燃煤排放，11 月—次年 3 月最明显。');
    } else {
      extra.push('<b>空间格局</b>：北方与内陆城市普遍高于沿海与南方，主要差异在燃煤强度、扩散条件和地形。');
    }
    var hour = new Date().getHours();
    if (hour >= 22 || hour <= 7) extra.push('<b>时段</b>：当前为夜间，边界层压低、扩散变差，颗粒物更容易累积。');
    else if (hour >= 12 && hour <= 17 && top.name === 'O₃') extra.push('<b>时段</b>：当前正值午后强日照，臭氧生成最活跃。');

    return '<b>' + where + '</b> 当前 AQI ' + num(val) + '（' + lv.label + '），首要污染物 <b>' + top.name + '</b>。' +
      '<br/><br/>' + txt.why + '<br/>' + txt.keep +
      (extra.length ? '<br/><br/>' + extra.join('<br/>') : '') +
      '<br/><br/><b>改善方向</b>：' +
      (top.name === 'O₃'
        ? '错峰加油、VOCs 与 NOx 协同减排，午后减少户外剧烈运动。'
        : (top.name === 'NO₂'
          ? '公交优先、货运车辆绕城、路口信号优化。'
          : '燃煤与工业深度治理 + 扬尘管控 + 重污染过程应急减排。')) +
      (d ? '<br/>想看具体数值就问「' + d.name + ' AQI」。' : '');
  }

  function trendAnswer(ds) {
    var s = window.AQApp.summary();
    var d = (ds && ds[0]) || null;
    var base = d ? d.aqi : s.avgAqi;
    var key = 't' + (d ? d.name : 'nation');
    var ser = window.AQ.series24(base, key, .18).map(function (p) { return p.v; });
    var n = ser.length;
    var now = ser[n - 1], prev3 = ser[n - 4], mx = Math.max.apply(null, ser), mn = Math.min.apply(null, ser);
    var diff = +(now - prev3).toFixed(1);
    var dir = diff > 3 ? '在上升' : (diff < -3 ? '在下降' : '基本平稳');
    return '<b>' + (d ? d.name : '全国平均') + '</b> 过去 24 小时在 <b>' + Math.round(mn) + ' – ' + Math.round(mx) +
      '</b> 之间波动，最新 ' + num(Math.round(now)) + '，近 3 小时' + dir + '（' + (diff >= 0 ? '+' : '') + diff + '）。' +
      '<br/>' + (dir === '在上升'
        ? '如果气象条件没有明显改善，短期内可能继续累积，建议关注本地预报并减少户外活动。'
        : (dir === '在下降'
          ? '扩散条件在变好，污染正在消散，适合通风换气。'
          : '处于平台期，波动主要受早晚高峰与边界层高度影响。')) +
      '<br/><span class="citychip" data-q="' + (d ? d.name : '全国') + '为什么污染">看成因分析</span>';
  }

  function answer(q) {
    if (/美食|吃什么|吃啥|好吃的|小吃|food|eat/i.test(q)) return foodAnswer(q);
    if (/旅游|旅行|出游|度假|去哪|去哪儿|周末|玩|适合去|出行推荐|travel|trip|visit/i.test(q)) return travelAnswer(q);
    var data = window.AQApp.data(), s = window.AQApp.summary();
    if (!data || !data.length) return '数据还在加载，稍等一下再问我。';

    /* 提到的城市 */
    var hits = [];
    (window.CITIES || []).forEach(function (c) {
      if (q.indexOf(c.name) >= 0 && hits.indexOf(c.name) < 0) hits.push(c.name);
    });
    var ds = hits.map(function (n) { return window.AQApp.city(n); }).filter(Boolean);

    /* 1. 双城对比 */
    if (ds.length >= 2) {
      var a = ds[0], b = ds[1];
      var diff = a.aqi - b.aqi;
      var who = diff === 0 ? '两者持平' : (diff < 0 ? a.name + ' 更干净' : b.name + ' 更干净');
      return '<b>' + a.name + '</b> ' + colorLv(a) + ' · ' + lvOf(a).label +
        '；<b>' + b.name + '</b> ' + colorLv(b) + ' · ' + lvOf(b).label +
        '<br/>差值 ' + num(Math.abs(diff)) + '，' + who + '。' +
        list([
          [a.name + ' PM2.5', a.pm2_5 + ''],
          [b.name + ' PM2.5', b.pm2_5 + ''],
          [a.name + ' 首要污染物', a.primary],
          [b.name + ' 首要污染物', b.primary]
        ]);
    }

    /* 2. 单城查询 */
    if (ds.length === 1) {
      var d = ds[0], lv = lvOf(d), lvIdx = window.AQ.levelIndex(d.aqi);
      var better = data.filter(function (x) { return x.aqi < d.aqi; }).length;
      return '<b>' + d.name + '</b> 当前 AQI ' + colorLv(d) + '（' + lv.label + '），首要污染物 ' +
        (d.primary === '—' ? '无' : '<b>' + d.primary + '</b>') + '。' +
        list([
          ['PM2.5', d.pm2_5 + ' μg/m³'],
          ['PM10', d.pm10 + ' μg/m³'],
          ['SO₂', d.sulphur_dioxide + ' μg/m³'],
          ['NO₂', d.nitrogen_dioxide + ' μg/m³'],
          ['O₃', d.ozone + ' μg/m³']
        ]) +
        '<br/>在全国 ' + num(s.count) + ' 个监测点里排第 ' + num(s.count - better) + ' 位（越小越好）。' +
        (lvIdx >= 2 ? '<br/>建议减少户外剧烈运动，敏感人群戴好口罩。' : '<br/>空气不错，适合开窗通风。');
    }

    /* 3. 成因分析 / 趋势（放在城市数值之前，避免被截走） */
    if (/为什么|原因|成因|分析|来源|怎么治理|治理|改善|这么高|哪儿来|怎么造成/.test(q)) {
      return causeAnalysis(ds);
    }
    if (/趋势|接下来|明天|什么时候|好转|预测|会不会/.test(q)) {
      return trendAnswer(ds);
    }

    /* 4. 最重 / 最好 */
    if (/最重|最差|最脏|污染最|排行榜|排名|TOP/i.test(q)) {
      var w = data.slice().sort(function (x, y) { return y.aqi - x.aqi; }).slice(0, 5);
      return '当前污染最重的 5 座城市：' +
        list(w.map(function (x) { return [chip(x), colorLv(x) + ' · ' + lvOf(x).label]; })) +
        '<br/>点城市名可以直接在地图上定位。';
    }
    if (/最好|最佳|最干净|最轻|最优/i.test(q)) {
      var g = data.slice().sort(function (x, y) { return x.aqi - y.aqi; }).slice(0, 5);
      return '当前空气最好的 5 座城市：' +
        list(g.map(function (x) { return [chip(x), colorLv(x) + ' · ' + lvOf(x).label]; }));
    }

    /* 4. 优良率 / 分级 */
    if (/优良|达标|好空气|比例|占比/i.test(q)) {
      return '全国 ' + num(s.count) + ' 座城市中，优良（AQI ≤ 100）<b>' + num(s.good) + '</b> 座，占 <b>' +
        num(s.goodPct + '%') + '</b>；污染 <b>' + num(s.polluted) + '</b> 座，占 ' + num(100 - s.goodPct) + '%。' +
        list([
          ['优（0–50）', s.counts[0]],
          ['良（51–100）', s.counts[1]],
          ['轻度（101–150）', s.counts[2]],
          ['中度及以上', s.counts[3] + s.counts[4] + s.counts[5]]
        ]);
    }

    /* 5. 污染物查询 */
    var POLL = { 'pm2_5': 'PM2.5', 'pm10': 'PM10', 'so2': 'SO₂', 'so 2': 'SO₂', 'no2': 'NO₂', 'o3': 'O₃', '臭氧': 'O₃' };
    var pk = null;
    if (/pm\s*2\.?5/i.test(q)) pk = 'pm2_5';
    else if (/pm\s*10/i.test(q)) pk = 'pm10';
    else if (/so\s*2|二氧化硫|so₂/i.test(q)) pk = 'sulphur_dioxide';
    else if (/no\s*2|二氧化氮|no₂/i.test(q)) pk = 'nitrogen_dioxide';
    else if (/o\s*3|臭氧|o₃/i.test(q)) pk = 'ozone';
    if (pk) {
      var label = { pm2_5: 'PM2.5', pm10: 'PM10', sulphur_dioxide: 'SO₂', nitrogen_dioxide: 'NO₂', ozone: 'O₃' }[pk];
      var avgKey = { pm2_5: 'pm2_5', pm10: 'pm10', sulphur_dioxide: 'so2', nitrogen_dioxide: 'no2', ozone: 'o3' }[pk];
      var t = topBy(pk, 3);
      return '全国 ' + label + ' 平均浓度 <b>' + num(s.avg[avgKey]) + '</b> μg/m³。浓度最高的 3 座城市：' +
        list(t.map(function (x) { return [chip(x), num((x[pk] || 0) + '')]; })) +
        '<br/>切到地图上的 ' + label + ' 标签可以看空间分布。';
    }

    /* 6. 首要污染物 */
    if (/首要|主要污染|污染物/i.test(q)) {
      return '当前首要污染物是 <b>' + s.primary + '</b>，在 ' + num(s.primaryCount || 0) + ' 座城市中作为首要污染物出现。' +
        list(Object.keys(s.primaryCounts || {}).map(function (k) { return [k, s.primaryCounts[k] + ' 城']; })
          .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4));
    }

    /* 7. 平均 */
    if (/平均|均值|总体|全国/.test(q)) {
      var lv2 = window.AQ.levelOf(s.avgAqi);
      return '全国平均 AQI 为 <b style="color:' + lv2.color + '">' + num(s.avgAqi) + '</b>，整体属于「' + lv2.label + '」。' +
        list([
          ['PM2.5 均值', s.avg.pm2_5 + ' μg/m³'],
          ['PM10 均值', s.avg.pm10 + ' μg/m³'],
          ['优良城市', s.good + ' / ' + s.count],
          ['污染最重', s.worst ? s.worst.name + ' ' + s.worst.aqi : '—']
        ]);
    }

    /* 8. 健康建议 */
    if (/建议|健康|出门|运动|口罩|通风|跑步/.test(q)) {
      var m = window.AQ.levelOf(s.avgAqi), worst = s.worst;
      var tips = {
        '优': '空气很好，适合户外运动和长时间开窗通风。',
        '良': '空气可以接受，极少数敏感人群可减少长时间户外活动。',
        '轻度污染': '儿童、老人和呼吸道疾病患者应减少户外运动。',
        '中度污染': '建议减少户外活动，外出佩戴口罩。',
        '重度污染': '避免户外活动，关闭门窗并使用空气净化器。',
        '严重污染': '尽量留在室内，必须外出请佩戴防护口罩。'
      }[m.label];
      return '全国平均 ' + num(s.avgAqi) + '（' + m.label + '）：' + tips +
        (worst ? '<br/>目前最需要注意的城市是 ' + chip(worst) + '（' + colorLv(worst) + '）。' : '');
    }

    /* 9. 城市数量 */
    if (/多少|几座|城市数|站点/.test(q)) {
      return '当前接入 ' + num(s.count) + ' 座城市监测点，覆盖 5 项污染物（PM2.5、PM10、SO₂、NO₂、O₃），按 HJ 633-2012 计算 AQI。';
    }

    /* 10. 帮助 */
    if (/帮助|help|你能|会什么|怎么用/i.test(q)) {
      return '我可以基于当前看板数据回答：' +
        list([
          ['城市数值', '“北京 AQI”'],
          ['城市对比', '“北京和上海对比”'],
          ['排名', '“污染最重的城市”'],
          ['空气质量', '“优良率多少”'],
          ['污染物', '“PM2.5 排名”'],
          ['健康建议', '“今天适合运动吗”']
        ]);
    }

    /* 兜底 */
    var lv3 = window.AQ.levelOf(s.avgAqi);
    return '我没太理解这个问题。目前全国平均 AQI ' + num(s.avgAqi) + '（' + lv3.label + '），优良城市 ' +
      num(s.good) + '/' + num(s.count) + '。<br/>可以试试：' +
      '<span class="citychip" data-q="污染最重的城市">污染最重</span> · ' +
      '<span class="citychip" data-q="北京 AQI">北京 AQI</span> · ' +
      '<span class="citychip" data-q="全国优良率">优良率</span>';
  }



  /* ---------------- 美食推荐库 ---------------- */
  var FOOD = {
    '北京': ['北京烤鸭', '炸酱面', '豆汁焦圈'],
    '上海': ['小笼包', '生煎', '葱油拌面'],
    '广州': ['肠粉', '白切鸡', '艇仔粥'],
    '深圳': ['沙井蚝', '光明乳鸽', '潮汕牛肉丸'],
    '成都': ['夫妻肺片', '担担面', '钟水饺'],
    '重庆': ['小面', '酸辣粉', '毛血旺'],
    '西安': ['肉夹馍', 'biangbiang面', '甑糕'],
    '杭州': ['片儿川', '东坡肉', '葱包桧'],
    '南京': ['盐水鸭', '鸭血粉丝汤', '皮肚面'],
    '武汉': ['热干面', '豆皮', '糊汤粉'],
    '长沙': ['臭豆腐', '糖油粑粑', '口味虾'],
    '厦门': ['沙茶面', '土笋冻', '海蛎煎'],
    '青岛': ['辣炒蛤蜊', '鲅鱼水饺', '原浆啤酒'],
    '哈尔滨': ['锅包肉', '红肠', '马迭尔冰棍'],
    '沈阳': ['老边饺子', '鸡架', '烤肉'],
    '昆明': ['过桥米线', '汽锅鸡', '烧饵块'],
    '三亚': ['椰子鸡', '清补凉', '海南粉'],
    '海口': ['海南粉', '老爸茶', '文昌鸡'],
    '拉萨': ['藏面', '甜茶', '牦牛肉'],
    '乌鲁木齐': ['大盘鸡', '烤包子', '手抓饭'],
    '兰州': ['牛肉面', '灰豆子', '酿皮'],
    '郑州': ['烩面', '胡辣汤', '焖饼'],
    '太原': ['刀削面', '头脑', '莜面栲栳栳'],
    '合肥': ['老乡鸡', '庐州烤鸭', '淮南牛肉汤'],
    '福州': ['鱼丸', '肉燕', '锅边糊'],
    '南昌': ['瓦罐汤', '拌粉', '白糖糕'],
    '贵阳': ['丝娃娃', '肠旺面', '酸汤鱼'],
    '南宁': ['老友粉', '酸嘢', '柠檬鸭'],
    '苏州': ['奥灶面', '松鼠桂鱼', '鲜肉月饼'],
    '天津': ['煎饼果子', '狗不理包子', '锅巴菜']
  };

  function foodAnswer(q) {
    var data = window.AQApp.data() || [];
    var city = null;
    data.forEach(function (d) { if (q.indexOf(d.name) >= 0 && (!city || d.name.length > city.length)) city = d.name; });
    if (!city) {
      var best = data.slice().sort(function (a, b) { return a.aqi - b.aqi; })[0];
      city = best ? best.name : '成都';
    }
    var dishes = FOOD[city] || ['当地小吃街', '早市', '本地人气馆子'];
    var d0 = data.filter(function (x) { return x.name === city; })[0] || { aqi: 60, primary: '—' };
    var lv = window.AQ.levelOf(d0.aqi);
    return '<b>' + city + ' 美食推荐</b>' + list(dishes.map(function (n, i) {
      return ['必吃 ' + (i + 1), n];
    })) +
      '<div class="ai-note">当地空气 ' + d0.aqi + '（' + lv.label + '）· 首要污染物 ' + d0.primary +
      '；' + (d0.aqi <= 50 ? '露天夜市可以放心逛' : d0.aqi <= 100 ? '建议室内餐厅为主，夜市戴口罩' : '优先室内，避免露天排档') +
      '</div>' +
      '<div class="ai-note">想看别的城市：直接问「去成都吃什么」。</div>';
  }

  /* ---------------- 旅游 / 出行推荐 ---------------- */
  var TRAVEL_TAGS = {
    '三亚': '海滩 + 潜水', '厦门': '海岛 + 老城', '昆明': '四季如春', '大理': '洱海 + 古城',
    '丽江': '古城 + 雪山', '杭州': '西湖 + 茶园', '成都': '美食 + 熊猫', '西安': '古城 + 博物馆',
    '青岛': '海边 + 啤酒', '哈尔滨': '冰雪 + 俄式建筑', '拉萨': '高原 + 寺庙', '桂林': '山水',
    '重庆': '夜景 + 火锅', '南京': '民国建筑 + 梧桐', '苏州': '园林', '长沙': '小吃 + 夜生活'
  };

  function travelIndex(aqi) {
    if (aqi <= 35) return { score: 5, label: '非常适合' };
    if (aqi <= 50) return { score: 4.5, label: '很适合' };
    if (aqi <= 75) return { score: 4, label: '适合' };
    if (aqi <= 100) return { score: 3, label: '一般，敏感人群注意' };
    if (aqi <= 150) return { score: 2, label: '不太适合长时间户外' };
    return { score: 1, label: '不建议前往（户外）' };
  }

  function travelAnswer(q) {
    var data = (window.AQApp.data() || []).slice();
    if (!data.length) return '还没有数据，先抓取一次实时数据吧。';
    var asked = null;
    data.forEach(function (d) { if (q.indexOf(d.name) >= 0 && (!asked || d.name.length > asked.length)) asked = d.name; });
    data.sort(function (a, b) { return a.aqi - b.aqi; });

    var rows = [];
    var pick = asked ? data.filter(function (d) { return d.name === asked; })[0] : data[0];
    if (!pick) pick = data[0];

    var idx = travelIndex(pick.aqi);
    var lv = window.AQ.levelOf(pick.aqi);
    var tag = TRAVEL_TAGS[pick.name] || '城市漫游';
    rows.push(['推荐指数', '★'.repeat(Math.round(idx.score)) + ' ' + idx.label]);
    rows.push(['当前 AQI', pick.aqi + ' · ' + lv.label + ' · 首要 ' + pick.primary]);
    rows.push(['玩法', tag]);
    var food = (typeof FOOD !== 'undefined' && FOOD[pick.name]) ? FOOD[pick.name].slice(0, 3).join(' / ') : '当地小吃街';
    rows.push(['必吃', food]);
    rows.push(['最佳时段', pick.aqi <= 75 ? '上午 8–11 点 / 傍晚 17–19 点（扩散较好）'
      : '午后 14–16 点（边界层最高），避开早晚高峰']);
    rows.push(['装备建议', pick.aqi <= 50 ? '普通口罩即可，可长时间户外'
      : pick.aqi <= 100 ? '敏感人群备 N95，运动减量'
      : 'N95 必备，户外单次不超过 1 小时']);
    if (window.AQ.levelOf(pick.aqi).label !== '优') {
      rows.push(['主要风险', pick.primary + ' 偏高，临水/临路区域更明显']);
    }

    var top3 = data.slice(0, 3).map(function (d) { return chip(d) + ' ' + d.aqi; }).join(' · ');
    var bad3 = data.slice(-3).reverse().map(function (d) { return chip(d) + ' ' + d.aqi; }).join(' · ');

    return '<b>' + pick.name + ' 出行评估</b>' + list(rows) +
      '<div class="ai-note">空气质量最好的三城：' + top3 + '</div>' +
      '<div class="ai-note">近期尽量避开：' + bad3 + '</div>' +
      '<div class="ai-note">想换目的地就问我「去成都旅游怎么样」。</div>';
  }

  var EN_MAP = [
    [/travel|trip|visit|tour/i, '旅游推荐'], [/food|eat|dish|cuisine/i, '美食推荐'],
    [/best|clean/i, '空气质量最佳的城市'], [/worst|pollut/i, '污染最重的城市'],
    [/trend|forecast|tomorrow/i, '接下来会好转吗'], [/why|cause|reason/i, '污染成因分析'],
    [/health|run|exercise|sport/i, '今天适合运动吗'], [/compare/i, '北京和上海对比'],
    [/\baqi\b|air quality|how is/i, '全国空气怎么样']
  ];
  function normalize(q) {
    if (!/[\u4e00-\u9fa5]/.test(q)) {
      for (var i = 0; i < EN_MAP.length; i++) if (EN_MAP[i][0].test(q)) return EN_MAP[i][1];
    }
    return q;
  }

  function ask(q) {
    q = (q || '').trim();
    if (!q) return;
    q = normalize(q);
    push('user', esc(q));
    input.value = '';
    var t = push('bot', '<span class="thinking"><i></i><i></i><i></i></span>');

    /* 配了模型就走大模型，失败/没配回落本地规则 */
    if (window.LLM && window.LLM.available) {
      window.LLM.ask(q).then(function (txt) {
        t.innerHTML = '<span class="who">' + (window.LLM.model || 'AI') + '</span>' +
          String(txt).replace(/\n/g, '<br/>');
        log.scrollTop = log.scrollHeight;
      }).catch(function (e) {
        var html = '';
        try { html = answer(q); } catch (e2) { html = '本地分析出错：' + (e2.message || e2); }
        t.innerHTML = '<span class="who">DATA ASSISTANT</span>' +
          '<div class="ai-note" style="color:#ffb86b">模型暂时不可用（' + String(e.message || e) +
          '），以下是本地分析：</div>' + html;
        log.scrollTop = log.scrollHeight;
      });
      return;
    }

    setTimeout(function () {
      var html;
      try { html = answer(q); } catch (e) { html = '出错了：' + esc(e.message); }
      t.innerHTML = '<span class="who">DATA ASSISTANT</span>' + html;
      log.scrollTop = log.scrollHeight;
    }, 420 + Math.random() * 260);
  }

  function greet() {
    push('bot', '你好，我是数据助手。可以问我：<br/>' +
      '<span class="citychip" data-q="污染最重的城市">污染最重的城市</span> · ' +
      '<span class="citychip" data-q="污染成因分析">污染成因</span> · ' +
      '<span class="citychip" data-q="北京 AQI 多少">北京 AQI</span> · ' +
      '<span class="citychip" data-q="接下来会好转吗">趋势判断</span>');
  }

  function init() {
    log = $('#aiLog'); form = $('#aiForm'); input = $('#aiInput');
    if (!log || !form || !window.AQApp) return false;

    form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });

    // 快捷词
    $('#aiChips').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      ask(b.dataset.q);
    });

    // 消息里的城市名 / 追问 chip
    log.addEventListener('click', function (e) {
      var c = e.target.closest('.citychip');
      if (!c) return;
      if (c.dataset.q) { ask(c.dataset.q); return; }
      var name = c.dataset.city;
      if (name && window.AQApp.select) {
        window.AQApp.select(name);
        push('bot', '已在地图上定位 <b>' + name + '</b>，右侧仪表盘也同步切到该城市。');
      }
    });

    greet();
    setTimeout(snapshot, 280);
    ready = true;
    return true;
  }

  /* 首屏/数据变更时的一条快照 */
  var snapEl = null;
  function snapshotHtml() {
    var s = window.AQApp && window.AQApp.summary();
    if (!s || !s.count) return '';
    var lv = window.AQ.levelOf(s.avgAqi);
    return '<b>当前快照</b><br/>全国平均 <b style="color:' + lv.color + '">' + s.avgAqi + '</b>（' + lv.label +
      '），优良 <b>' + s.good + '/' + s.count + '</b>，首要污染物 <b>' + s.primary + '</b>。' +
      '<br/>最重：' + (s.worst ? chip(s.worst) + ' ' + s.worst.aqi : '—') +
      '　最清洁：' + (s.best ? chip(s.best) + ' ' + s.best.aqi : '—');
  }
  function snapshot() {
    var html = snapshotHtml();
    if (!html) return;
    if (snapEl && snapEl.parentNode) {
      snapEl.innerHTML = '<span class="who">DATA ASSISTANT</span>' + html;
      log.scrollTop = log.scrollHeight;
      return;
    }
    snapEl = push('bot', html);
  }

  /* 数据变了（抓取实时数据 / 刷新）就更新这条快照 */
  document.addEventListener('aq:update', function () {
    if (!ready) return;
    setTimeout(snapshot, 60);
  });

  function boot() {
    if (init()) return;
    var tries = 0;
    var t = setInterval(function () {
      if (init() || ++tries > 40) clearInterval(t);
    }, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.AIChat = { ask: ask };
})();
