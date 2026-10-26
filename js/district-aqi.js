/* ============================================================================
   district-aqi.js —— 区县 AQI 估算（可解释模型，替代原来的 name.hash 假数）
   优先级：真实实测（暂无接口）→ 可解释模型 → 不使用伪随机
   f = 1 + wDist·距市中心归一化 + wInd·工业标志 − wGreen·绿地/水域标志
   最后按均值归一，保证「区县均值 ≈ 城市 AQI」
   ========================================================================== */
(function () {
  'use strict';

  var MODEL = {
    wDist: 0.18,
    wInd: 0.12,
    wGreen: 0.10,
    industryWords: ['工业', '开发', '钢', '化工', '冶', '产业园', '新区', '港', '矿'],
    greenWords: ['湖', '山', '林', '公园', '湿地', '江', '河', '泉', '谷', '岛', '湾']
  };

  function has(name, words) {
    for (var i = 0; i < words.length; i++) if (name.indexOf(words[i]) >= 0) return 1;
    return 0;
  }

  function dist(a, b) {
    var dx = (a.lng - b.lng) * Math.cos((a.lat || 0) * Math.PI / 180);
    var dy = (a.lat - b.lat);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * @param city   {name, lat, lng, aqi}
   * @param districts [{name, center:{lng,lat}}]
   * @returns [{name, aqi, source, factor}]
   */
  function estimate(city, districts) {
    var base = (city && city.aqi) || 60;
    var c = { lat: city && city.lat, lng: city && city.lng };
    if (!districts || !districts.length) return [];

    /* 距离归一化 */
    var ds = districts.map(function (u) {
      if (!u.center || !isFinite(u.center.lng)) return 0;
      return dist(u.center, c);
    });
    var maxD = Math.max.apply(null, ds.concat([1e-6]));

    var raw = districts.map(function (u, i) {
      var nd = ds[i] / maxD;                       /* 0 市中心 → 1 最远 */
      var ind = has(u.name, MODEL.industryWords);
      var green = has(u.name, MODEL.greenWords);
      var f = 1 + MODEL.wDist * nd + MODEL.wInd * ind - MODEL.wGreen * green;
      return { u: u, f: f };
    });

    /* 均值归一：让区县均值 = 城市值 */
    var mean = raw.reduce(function (a, r) { return a + r.f; }, 0) / raw.length || 1;

    return raw.map(function (r) {
      var f = r.f / mean;
      return {
        name: r.u.name,
        aqi: Math.max(8, Math.round(base * f)),
        factor: +f.toFixed(3),
        source: 'estimated'
      };
    });
  }

  window.AQEstimate = { estimate: estimate, MODEL: MODEL };
})();
