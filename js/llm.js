/* ============================================================================
   llm.js —— OpenAI 兼容的大模型客户端（可选）
   在 js/config.js 里填 llm.apiKey / baseUrl / model 即可启用；
   没填就自动回落到本地规则引擎（ai.js），不会报错。
   ========================================================================== */
(function () {
  'use strict';

  var cfg = (window.MAP_CONFIG && window.MAP_CONFIG.llm) || {};
  var provider = cfg.provider || (cfg.apiKey ? 'openai' : 'free');
  /* free：免 Key 的公共模型（30 秒一次限流）；openai：自填 key 的兼容接口 */
  var enabled = cfg.enabled !== false && (provider === 'free' || !!(cfg.apiKey && cfg.model));
  var lastCall = 0, MIN_GAP = 32000;

  function systemPrompt() {
    return [
      '你是一个空气质量数据助手，服务于一块中文空气质量监测大屏。',
      '回答要求：',
      '1) 用中文，口语化，不超过 160 字；',
      '2) 必须基于我给的实时数据，不要编造城市数值；',
      '3) 涉及健康建议时给出具体行动（戴不戴口罩、能不能户外运动、开不开窗）；',
      '4) 涉及旅游时，给出「适不适合去 + 最佳时段 + 适合人群 + 一句提醒」；',
      '5) 不要用 Markdown 标题，可以用短句和「·」列表。'
    ].join('\n');
  }

  function context(q) {
    var s = (window.AQApp && window.AQApp.summary()) || {};
    var data = (window.AQApp && window.AQApp.data()) || [];
    var worst = data.slice().sort(function (a, b) { return b.aqi - a.aqi; }).slice(0, 3)
      .map(function (d) { return d.name + d.aqi; }).join('、');
    var best = data.slice().sort(function (a, b) { return a.aqi - b.aqi; }).slice(0, 3)
      .map(function (d) { return d.name + d.aqi; }).join('、');
    return '【数据】均值' + (s.avgAqi || '-') + '，优良' + (s.good || 0) + '/' + (s.count || 0) +
      '，首要' + (s.primary || '-') + '，最脏' + (worst || '-') + '，最好' + (best || '-') + '。' +
      cityLine(q);
  }

  /* 问题里点名的城市，把它的实测值塞进去 */
  function cityLine(q) {
    var data = (window.AQApp && window.AQApp.data()) || [];
    if (!q || !data.length) return '';
    var hit = null;
    data.forEach(function (d) { if (q.indexOf(d.name) >= 0 && (!hit || d.name.length > hit.name.length)) hit = d; });
    if (!hit) return '';
    return '【点名城市】' + hit.name + ' AQI ' + hit.aqi + '（' + (window.AQ.levelOf(hit.aqi).label) + '）' +
      '，PM2.5 ' + hit.pm2_5 + '，PM10 ' + hit.pm10 + '，SO₂ ' + hit.so2 +
      '，NO₂ ' + hit.no2 + '，O₃ ' + hit.o3 + '。';
  }

  function buildPrompt(question) {
    return '你是中文空气质量助手，必须基于数据、不编造，140字内，给具体建议；' +
      '问旅游给"适不适合去+最佳时段"，问美食给2-3个具体菜名；用户说英文则中文作答并附一句英文。' +
      context(question) + '问题：' + question;
  }

  function askFree(question) {
    var gap = Date.now() - lastCall;
    if (gap < MIN_GAP) {
      return Promise.reject(new Error('限流：还要等 ' + Math.ceil((MIN_GAP - gap) / 1000) + ' 秒'));
    }
    lastCall = Date.now();
    var url = 'https://text.pollinations.ai/' + encodeURIComponent(buildPrompt(question));
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.text();
    }).then(function (t) {
      if (!t) throw new Error('empty');
      if (/Free limit reached|rate limit/i.test(t)) throw new Error('公共模型限流，稍后再试');
      return t.trim();
    });
  }

  function ask(question) {
    if (!enabled) return Promise.reject(new Error('llm-not-configured'));
    if (provider === 'free') return askFree(question);
    lastCall = Date.now();
    var base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    var body = {
      model: cfg.model,
      temperature: 0.6,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'system', content: context(question) },
        { role: 'user', content: question }
      ]
    };
    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      /* 模型名不存在时自动退回 fallbackModel */
      if (r.ok) return r.json();
      return r.json().catch(function () { return {}; }).then(function (j) {
        var msg = (j.error && j.error.message) || ('HTTP ' + r.status);
        if (cfg.fallbackModel && cfg.fallbackModel !== cfg.model) {
          body.model = cfg.fallbackModel;
          return fetch(base + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
            body: JSON.stringify(body)
          }).then(function (r2) {
            if (!r2.ok) throw new Error(msg);
            return r2.json();
          });
        }
        throw new Error(msg);
      });
    }).then(function (j) {
      var txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!txt) throw new Error('empty');
      return txt.trim();
    });
  }

  window.LLM = {
    available: enabled,
    model: provider === 'free' ? '在线模型' : (cfg.model || ''),
    ask: ask,
    info: function () {
      return enabled ? ('已接入 ' + (provider === 'free' ? '免费公共模型' : cfg.model)) : '未配置';
    }
  };
})();
