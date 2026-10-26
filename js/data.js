/* ============================================================================
   数据层 —— 城市表 / 国标 AQI 算法 / 仿真 / 实时 API / Excel 导入
   与原项目保持同一套数据口径，只重写呈现层。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- AQI 等级（色彩按看板视觉重新调过，语义不变） ---------- */
  var LEVELS = [
    { key: 'excellent', label: '优',       min: 0,   max: 50,   color: '#46e0b0' },
    { key: 'good',      label: '良',       min: 51,  max: 100,  color: '#cfd267' },
    { key: 'mild',      label: '轻度污染', min: 101, max: 150,  color: '#ffa93d' },
    { key: 'moderate',  label: '中度污染', min: 151, max: 200,  color: '#ff6b52' },
    { key: 'heavy',     label: '重度污染', min: 201, max: 300,  color: '#c85be0' },
    { key: 'severe',    label: '严重污染', min: 301, max: 9999, color: '#8c1f3d' }
  ];

  function levelOf(aqi) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (aqi >= LEVELS[i].min && aqi <= LEVELS[i].max) return LEVELS[i];
    }
    return LEVELS[LEVELS.length - 1];
  }
  function levelIndex(aqi) { return LEVELS.indexOf(levelOf(aqi)); }

  /* ---------- 中国标准 IAQI ---------- */
  var BP = {
    pm2_5: [[0,35,0,50],[35,75,51,100],[75,115,101,150],[115,150,151,200],[150,250,201,300],[250,500,301,500]],
    pm10:  [[0,50,0,50],[50,150,51,100],[150,250,101,150],[250,350,151,200],[350,420,201,300],[420,600,301,500]],
    so2:   [[0,150,0,50],[150,500,51,100],[500,650,101,150],[650,800,151,200],[800,1600,201,300],[1600,2100,301,500]],
    no2:   [[0,100,0,50],[100,200,51,100],[200,700,101,150],[700,1200,151,200],[1200,2340,201,300],[2340,3090,301,500]],
    o3:    [[0,160,0,50],[160,200,51,100],[200,300,101,150],[300,400,151,200],[400,800,201,300],[800,1000,301,500]]
  };

  function iaqi(C, bp) {
    if (C == null || isNaN(C)) return 0;
    for (var i = 0; i < bp.length; i++) {
      var b = bp[i];
      if (C >= b[0] && C <= b[1]) {
        return Math.round((b[3] - b[2]) / (b[1] - b[0]) * (C - b[0]) + b[2]);
      }
    }
    return C > bp[bp.length - 1][1] ? 500 : 0;
  }

  function calcChinaAQI(d) {
    var list = [
      { name: 'PM2.5', key: 'pm2_5', val: iaqi(d.pm2_5, BP.pm2_5) },
      { name: 'PM10',  key: 'pm10',  val: iaqi(d.pm10, BP.pm10) },
      { name: 'SO₂',   key: 'so2',   val: iaqi(d.sulphur_dioxide, BP.so2) },
      { name: 'NO₂',   key: 'no2',   val: iaqi(d.nitrogen_dioxide, BP.no2) },
      { name: 'O₃',    key: 'o3',    val: iaqi(d.ozone, BP.o3) }
    ];
    var top = list[0];
    for (var i = 1; i < list.length; i++) if (list[i].val > top.val) top = list[i];
    return { aqi: top.val, primary: top.val <= 50 ? '—' : top.name, iaqis: list };
  }

  /* ---------- 仿真数据：地理位置驱动的确定性噪声 + 昼夜节律 ---------- */
  var INDUSTRIAL = ['石家庄','唐山','邯郸','太原','大同','包头','鞍山','淄博','武汉','洛阳','西安','兰州','石嘴山','乌鲁木齐','克拉玛依','天津','济南','郑州','徐州','无锡','株洲'];
  var COASTAL    = ['大连','烟台','青岛','厦门','深圳','珠海','三亚','海口','宁波','温州','泉州','桂林','大理','昆明','拉萨','日喀则','呼伦贝尔','鄂尔多斯','西宁'];
  var DUST       = ['乌鲁木齐','克拉玛依','喀什','巴彦淖尔','乌兰察布','银川','石嘴山','中卫','吴忠','兰州','西宁','包头','鄂尔多斯'];
  var CAPITAL    = ['北京','上海','天津','重庆','广州','成都','武汉','西安','南京','杭州','沈阳','长春','哈尔滨','济南','郑州','长沙','合肥','福州','南昌','石家庄','太原','呼和浩特','兰州','西宁','银川','乌鲁木齐','昆明','贵阳','拉萨','南宁','海口'];

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }
  function rngFactory(seed) {
    var s = seed;
    return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  /**
   * 生成一轮仿真数据
   * @param {number} t  时间片（每小时 +1），用于动态模式平滑演进
   */
  function simulate(t) {
    t = t || 0;
    var hour = (new Date().getHours() + t) % 24;
    // 昼夜节律：夜间边界层低 → 污染累积；午后 O3 抬升
    var diurnal = 1 + 0.26 * Math.cos((hour - 7) / 24 * Math.PI * 2);
    var rush = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 20) ? 1.12 : 1.0;

    return global.CITIES.map(function (c) {
      var rnd = rngFactory(Math.floor(hash(c.name) * 1e7) + t * 7);
      var lat = c.lat;
      var pm25 = 26 + (lat - 22) * 1.05;
      var pm10 = 44 + (lat - 22) * 1.35;
      var so2  = 7 + (lat - 22) * 0.26;
      var no2  = 24 + (lat - 22) * 0.72;
      var o3   = 62 - (lat - 22) * 0.55;

      if (INDUSTRIAL.indexOf(c.name) >= 0) { pm25 *= 1.48; pm10 *= 1.38; so2 *= 1.75; no2 *= 1.38; }
      if (COASTAL.indexOf(c.name) >= 0)    { pm25 *= 0.52; pm10 *= 0.60; so2 *= 0.52; no2 *= 0.62; }
      if (DUST.indexOf(c.name) >= 0)       { pm10 *= 1.75; }
      if (CAPITAL.indexOf(c.name) >= 0)    { no2 *= 1.28; }

      pm25 = Math.max(4, pm25 * (0.74 + rnd() * 0.58) * diurnal * rush);
      pm10 = Math.max(9, pm10 * (0.74 + rnd() * 0.58) * diurnal);
      so2  = Math.max(2, so2  * (0.62 + rnd() * 0.85) * diurnal);
      no2  = Math.max(6, no2  * (0.72 + rnd() * 0.62) * rush);
      o3   = Math.max(16, o3  * (0.82 + rnd() * 0.42) * (1 + 0.30 * Math.cos((hour - 15) / 24 * Math.PI * 2)));

      var r = calcChinaAQI({ pm2_5: pm25, pm10: pm10, sulphur_dioxide: so2, nitrogen_dioxide: no2, ozone: o3 });
      return {
        name: c.name, province: c.province, lat: c.lat, lng: c.lng,
        pm2_5: +pm25.toFixed(1), pm10: +pm10.toFixed(1),
        sulphur_dioxide: +so2.toFixed(1), nitrogen_dioxide: +no2.toFixed(1), ozone: +o3.toFixed(1),
        aqi: r.aqi, primary: r.primary, iaqis: r.iaqis, time: Date.now()
      };
    });
  }

  /* ---------- 实时数据（Open-Meteo，浏览器直连，无需后端） ---------- */
  function openMeteoURL(city) {
    return 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + city.lat +
      '&longitude=' + city.lng +
      '&current=pm2_5,pm10,sulphur_dioxide,nitrogen_dioxide,ozone,carbon_monoxide' +
      '&timezone=Asia%2FShanghai';
  }

  function fetchOne(city) {
    return fetch(openMeteoURL(city), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.current) return null;
        var c = j.current;
        var r2 = calcChinaAQI(c);
        return {
          name: city.name, province: city.province, lat: city.lat, lng: city.lng,
          pm2_5: +(+c.pm2_5).toFixed(1),
          pm10: +(+c.pm10).toFixed(1),
          sulphur_dioxide: +(+c.sulphur_dioxide).toFixed(1),
          nitrogen_dioxide: +(+c.nitrogen_dioxide).toFixed(1),
          ozone: +(+c.ozone).toFixed(1),
          carbon_monoxide: +(+c.carbon_monoxide).toFixed(1),
          aqi: r2.aqi, primary: r2.primary, iaqis: r2.iaqis,
          time: c.time || Date.now()
        };
      })
      .catch(function () { return null; });
  }

  /** 并发抓取（8 路并发，带进度回调） */
  function fetchOpenMeteo(cities, onProgress) {
    cities = cities || global.CITIES;
    var out = [], done = 0, idx = 0, LIMIT = 8;
    return new Promise(function (resolve) {
      function next() {
        if (idx >= cities.length) return;
        var city = cities[idx++];
        fetchOne(city).then(function (d) {
          if (d) out.push(d);
        }).catch(function () {}).then(function () {
          done++;
          if (onProgress) onProgress(done, cities.length);
          if (done >= cities.length) resolve(out);
          else next();
        });
      }
      for (var i = 0; i < LIMIT && i < cities.length; i++) next();
    });
  }

  /* 兼容旧名字 */
  var fetchRealtime = fetchOpenMeteo;

  /* ---------- 顶部天气 + PM2.5（郑州） ---------- */
  var WX = { 0: '☀', 1: '☀', 2: '⛅', 3: '☁', 45: '≡', 48: '≡', 51: '☂', 53: '☂', 55: '☂',
             61: '☂', 63: '☂', 65: '☂', 71: '❄', 73: '❄', 75: '❄', 80: '☂', 81: '☂', 82: '☂',
             95: '⚡', 96: '⚡', 99: '⚡' };

  function fetchWeather() {
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=34.7466&longitude=113.6254' +
      '&current=temperature_2m,weather_code&timezone=Asia%2FShanghai';
    var a = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=34.7466&longitude=113.6254' +
      '&current=pm2_5&timezone=Asia%2FShanghai';
    return Promise.all([
      fetch(u, { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch(a, { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]).then(function (arr) {
      var w = arr[0] && arr[0].current, q = arr[1] && arr[1].current;
      if (!w && !q) return null;
      return {
        temp: (w && w.temperature_2m) || 0,
        icon: (w && WX[w.weather_code]) || '◐',
        pm25: (q && q.pm2_5) || 0
      };
    });
  }

  /* ---------- 导出 Excel（用页面里已经引的 SheetJS） ---------- */
  function exportExcel(data) {
    if (!global.XLSX || !data || !data.length) return false;
    var rows = data.map(function (d) {
      return {
        '城市': d.name, '省份': d.province, 'AQI': d.aqi,
        '等级': levelOf(d.aqi).label,
        'PM2.5(μg/m³)': d.pm2_5, 'PM10(μg/m³)': d.pm10,
        'SO₂(μg/m³)': d.sulphur_dioxide, 'NO₂(μg/m³)': d.nitrogen_dioxide,
        'O₃(μg/m³)': d.ozone, 'CO(mg/m³)': d.carbon_monoxide || '',
        '首要污染物': d.primary
      };
    });
    var ws = global.XLSX.utils.json_to_sheet(rows);
    var wb = global.XLSX.utils.book_new();
    global.XLSX.utils.book_append_sheet(wb, ws, '城市监测数据');
    var t = new Date();
    var name = '空气质量_' + t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) +
      '_' + pad2(t.getHours()) + pad2(t.getMinutes()) + '.xlsx';
    global.XLSX.writeFile(wb, name);
    return true;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function parseExcel(file) {
    return new Promise(function (resolve, reject) {
      if (typeof XLSX === 'undefined') return reject(new Error('未加载 xlsx 解析库'));
      var fr = new FileReader();
      fr.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
          var coord = {};
          global.CITIES.forEach(function (c) { coord[c.name] = c; });
          var data = rows.map(function (r) {
            var name = r['城市名称'] || r['城市'] || r['name'];
            if (!name) return null;
            var c = coord[name] || { lat: 35, lng: 105, province: '—' };
            var d = {
              name: name, province: r['省份'] || c.province, lat: r['纬度'] || c.lat, lng: r['经度'] || c.lng,
              pm2_5: +(r['PM2.5(μg/m³)'] || r['PM2.5'] || 0),
              pm10: +(r['PM10(μg/m³)'] || r['PM10'] || 0),
              sulphur_dioxide: +(r['SO₂(μg/m³)'] || r['SO2'] || 0),
              nitrogen_dioxide: +(r['NO₂(μg/m³)'] || r['NO2'] || 0),
              ozone: +(r['O₃(μg/m³)'] || r['O3'] || 0),
              time: Date.now()
            };
            var rr = calcChinaAQI(d);
            d.aqi = +(r['AQI'] || rr.aqi);
            d.primary = r['首要污染物'] || rr.primary;
            d.iaqis = rr.iaqis;
            return d;
          }).filter(Boolean);
          if (!data.length) return reject(new Error('表格中没有可识别的城市行'));
          resolve(data);
        } catch (err) { reject(err); }
      };
      fr.onerror = reject;
      fr.readAsArrayBuffer(file);
    });
  }

  /* ---------- 聚合 ---------- */
  function summarize(data) {
    var n = data.length || 1;
    var sum = { aqi: 0, pm2_5: 0, pm10: 0, so2: 0, no2: 0, o3: 0 };
    var counts = [0, 0, 0, 0, 0, 0];
    var primaryCount = {};
    var good = 0, polluted = 0, worst = null, best = null;

    data.forEach(function (d) {
      sum.aqi += d.aqi; sum.pm2_5 += d.pm2_5; sum.pm10 += d.pm10;
      sum.so2 += d.sulphur_dioxide; sum.no2 += d.nitrogen_dioxide; sum.o3 += d.ozone;
      counts[levelIndex(d.aqi)]++;
      if (d.aqi <= 100) good++; else polluted++;
      if (d.primary && d.primary !== '—') primaryCount[d.primary] = (primaryCount[d.primary] || 0) + 1;
      if (!worst || d.aqi > worst.aqi) worst = d;
      if (!best || d.aqi < best.aqi) best = d;
    });

    var primary = '—', max = 0;
    Object.keys(primaryCount).forEach(function (k) {
      if (primaryCount[k] > max) { max = primaryCount[k]; primary = k; }
    });

    return {
      count: data.length,
      avgAqi: Math.round(sum.aqi / n),
      avg: {
        pm2_5: +(sum.pm2_5 / n).toFixed(1), pm10: +(sum.pm10 / n).toFixed(1),
        so2: +(sum.so2 / n).toFixed(1), no2: +(sum.no2 / n).toFixed(1), o3: +(sum.o3 / n).toFixed(1)
      },
      counts: counts, good: good, polluted: polluted,
      goodPct: Math.round(good / n * 100),
      primary: primary, primaryCount: max, primaryCounts: primaryCount,
      worst: worst, best: best
    };
  }

  /* ---------- 24 小时序列（基于当前均值 + 节律，确定性） ---------- */
  function series24(baseVal, seedKey, amp) {
    var rnd = rngFactory(Math.floor(hash(seedKey || 'x') * 1e7));
    var out = [], now = new Date().getHours();
    for (var i = 23; i >= 0; i--) {
      var h = (now - i + 24) % 24;
      var diurnal = 1 + 0.24 * Math.cos((h - 7) / 24 * Math.PI * 2);
      var v = baseVal * diurnal * (1 + (rnd() - 0.5) * (amp || 0.24));
      out.push({ h: h, v: Math.max(1, +v.toFixed(1)) });
    }
    return out;
  }

  global.AQ = {
    LEVELS: LEVELS, levelOf: levelOf, levelIndex: levelIndex,
    calcChinaAQI: calcChinaAQI, iaqi: iaqi, BP: BP,
    simulate: simulate,
    fetchOpenMeteo: fetchOpenMeteo, fetchRealtime: fetchRealtime,
    fetchWeather: fetchWeather, exportExcel: exportExcel,
    parseExcel: parseExcel,
    summarize: summarize, series24: series24, hash: hash
  };
})(window);
