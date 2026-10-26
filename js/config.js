/* ============================================================================
   底图配置
   如需换 Key 或加百度，改这里即可，不用动其它代码。
   ========================================================================== */
window.MAP_CONFIG = {
  /* 'auto' = 有高德用高德，其次百度，都没有用内置矢量（推荐） */
  provider: 'auto',

  /* 首屏视图：'nation' 全国总览 | 'cascade' 三级联动 */
  defaultMode: 'nation',

  /* ---------- 高德（Web端 JS API） ---------- */
  amapKey: '',
  amapSecurity: '',   // 安全密钥 jscode
  amapStyle: 'amap://styles/darkblue',

  /* ---------- 百度（浏览器端 AK，可选） ---------- */
  bmapKey: '',
  bmapStyle: 'dark',

  /* ---------- 大模型（可选，OpenAI 兼容接口） ----------
     填了 apiKey + model 就自动启用；留空则用内置规则引擎。
     支持 OpenAI / DeepSeek / 通义 / Moonshot / 本地 vLLM 等相同协议的服务。 */
  llm: {
    /* 'openai' = 自填 key 的 OpenAI 兼容接口（DeepSeek 已接好）
       'free'   = 免 Key 的公共模型（30 秒一次限流，兜底用） */
    provider: 'openai',
    enabled: false,
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-flash',
    fallbackModel: 'deepseek-chat'
  },

  /* ---------- 实时 API 自动刷新间隔（毫秒） ---------- */
  liveRefreshMs: 300000
};
