// POST /api/prospect-search — 搜客池 Phase 2：站内搜公司（DeepSeek Search + Fetch）
// 流程：DeepSeek Search 找公司 → 对每家官网做 Fetch 读页、核对潜水料证据 →
//   返回规范行，前端走已有的清洗 / 去重 / 打分 / 预览 / 确认导入（与 Excel 导入同一条路）。
// 本接口不写库、不转客户，只搜 + 核验；写库永远是用户在页面上点“确认导入”才发生。
//
// DeepSeek 机制（api-docs.deepseek.com，2026-11-21 核对）：
//   Search API：POST https://api.deepseek.com/v1/tools/search
//     请求 { query（1-128 字，必填）, count（1-50，默认 10）, ori_question?,
//            localization?, need_content? }，返回 { results: [{ rerank_score,
//            title, url, snippet, summary, content, site_name, site_icon, date,
//            authority }] }。查询支持 site: / -site: / lang: 等操作符。
//   Fetch API：POST https://api.deepseek.com/v1/tools/fetch，请求 { url }，
//     返回 { title, content }（正文是 Markdown）。
//   两者都用同一个 Bearer API key，$0.75 / 1000 次成功请求（失败、空结果不计费）。
//   另有 deepseek-flash + deepseek_web_search 的站内聊天搜索，本接口不用它——
//   独立 Search/Fetch 返回结构化结果，可确定性地走打分/去重，不依赖模型发挥。
//   参考：https://api-docs.deepseek.com/guides/search/
//        https://api-docs.deepseek.com/api/search/
//   备选（未用）：https://api-docs.deepseek.com/guides/build_a_chatbot/
//
// 环境变量（Vercel 项目设置里填；部署前就要配好，否则接口直接报缺 key）：
//   DEEPSEEK_API_KEY=<DeepSeek API key，仅存 Vercel，不进仓库、不打日志、不返回前端>
// 计费提示：一次搜索 = 1 次 Search（$0.75/1000）+ 最多 10 次 Fetch（$0.75/1000），
//   约 $0.008/次；余额不足时 DeepSeek 返回 402，本接口原样报给前端。
//
// 请求 JSON：{ keyword, country? }
//   keyword 关键词（必填，1-100 字；中文即可，如“定制潜水服”）
//   country  国家（可选，如“西班牙”；不填则不限制国家）
// 返回 JSON：{ ok: true, companies: [规范行...], meta: {...} }
//   规范行与 app.js 的 normalizeProspectRow 输出同形，可直接进 processProspectImport。
//   一次最多返回 PROSPECT_SEARCH_MAX_RESULTS = 10 家（服务端硬上限）。
//   失败：{ ok: false, error: '...' }，HTTP 400（校验）或 500（缺 key / DeepSeek 报错）。
//   key 缺失、余额不足、搜索无结果时，错误信息直接说明原因，不让前端猜。

'use strict';

var DEEPSEEK_BASE = 'https://api.deepseek.com';
var SEARCH_URL = DEEPSEEK_BASE + '/v1/tools/search';
var FETCH_URL = DEEPSEEK_BASE + '/v1/tools/fetch';
// 一次搜索最多返回几家公司（用户定的上限；服务端硬卡，Search 多要的结果也只取这么多）。
var PROSPECT_SEARCH_MAX_RESULTS = 10;
var SEARCH_COUNT = 20; // 向 DeepSeek 多要几条，按域名去重后只留前 10 家
var SEARCH_TIMEOUT_MS = 30000;
var FETCH_TIMEOUT_MS = 20000;
var DEADLINE_MS = 120000; // 本函数整体软截止；超时仍返回已拿到的结果，不空手
// 潜水料证据词：与 app.js 的 PROSPECT_EVIDENCE_WORDS 保持一致（两边改一处时另一处一起改）。
var EVIDENCE_WORDS = ['neoprene', 'chloroprene', '氯丁橡胶', '潜水料', 'wetsuit material', 'cr sheet', 'sbr sheet'];
// 关键词/国家的中英对照：搜索用英文查海外公司效果更好；
//   对照表里没有的词原样传过去（DeepSeek Search 本身支持多语言查询）。
var KEYWORD_EN = {
  '定制潜水服': 'custom neoprene wetsuits',
  '氯丁橡胶潜水服': 'chloroprene rubber wetsuits',
  '潜水装备': 'dive equipment neoprene',
  '冲浪潜水服': 'surf wetsuits neoprene'
};
var COUNTRY_EN = {
  '西班牙': 'Spain', '法国': 'France', '德国': 'Germany', '英国': 'UK', '美国': 'USA',
  '澳大利亚': 'Australia', '加拿大': 'Canada', '意大利': 'Italy', '荷兰': 'Netherlands',
  '葡萄牙': 'Portugal', '比利时': 'Belgium', '瑞士': 'Switzerland', '奥地利': 'Austria',
  '丹麦': 'Denmark', '瑞典': 'Sweden', '挪威': 'Norway', '芬兰': 'Finland',
  '波兰': 'Poland', '希腊': 'Greece', '土耳其': 'Turkey', '巴西': 'Brazil',
  '墨西哥': 'Mexico', '新西兰': 'New Zealand', '南非': 'South Africa',
  '阿联酋': 'UAE', '以色列': 'Israel', '爱尔兰': 'Ireland', '捷克': 'Czech Republic'
};

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function normalizeSearchDomain(u) {
  var s = String(u || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0].trim();
  return s;
}

// 搜索查询：英文关键词 + 国家 + lang:en（DeepSeek Search 支持 lang: 操作符）。
// 关键词超过长度上限时只截关键词部分（国家 + lang:en 保留）；总长不超过 128 字。
function buildSearchQuery(keyword, country) {
  var kw = String(keyword || '').trim();
  var enKw = KEYWORD_EN[kw] || kw;
  var enCountry = country ? (COUNTRY_EN[String(country).trim()] || String(country).trim()) : '';
  var q = enKw + (enCountry ? ' ' + enCountry : '') + ' lang:en';
  if (q.length > 128) {
    var keep = 128 - (enCountry ? enCountry.length + 1 : 0) - ' lang:en'.length;
    q = enKw.slice(0, Math.max(1, keep)) + (enCountry ? ' ' + enCountry : '') + ' lang:en';
  }
  return q;
}

// 公司名清洗：优先 site_name；其次标题里分隔符前的品牌部分；都没有就从域名拼。
function cleanCompanyName(title, siteName, domain) {
  var name = String(siteName || '').trim();
  if (name) return name;
  var t = String(title || '').trim();
  if (t) {
    var head = t.split(/\s*[|｜\-–—:：]\s*/)[0].trim();
    if (head.length >= 2) return head;
    return t;
  }
  var base = String(domain || '').split('.')[0].replace(/[-_]+/g, ' ').trim();
  if (!base) return '';
  return base.split(' ').map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }).join(' ');
}

// 在一段文本里找潜水料证据词；命中返回以命中处为中心的摘录（≤ maxLen 字），否则返回 ''。
// 摘录先清 Markdown 符号、空白折叠，方便前端的硬规则和打分直接用。
function findEvidenceExcerpt(text, maxLen) {
  var raw = String(text || '');
  if (!raw) return '';
  var low = raw.toLowerCase();
  var hitAt = -1, hitLen = 0;
  for (var i = 0; i < EVIDENCE_WORDS.length; i++) {
    var at = low.indexOf(EVIDENCE_WORDS[i]);
    if (at !== -1 && (hitAt === -1 || at < hitAt)) { hitAt = at; hitLen = EVIDENCE_WORDS[i].length; }
  }
  if (hitAt === -1) return '';
  var start = Math.max(0, hitAt - 120);
  var end = Math.min(raw.length, hitAt + hitLen + (maxLen - 120));
  var out = raw.slice(start, end).replace(/[#>*_`\[\]()!|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (out.length > maxLen) out = out.slice(0, maxLen).trim();
  return out;
}

var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var EMAIL_DENY_LOCAL = ['noreply', 'donotreply', 'no-reply', 'postmaster'];
// 从抓到的页面文本里取第一个能用的邮箱（不编造；没有就返回 ''，前端打分那一维记 0）。
function extractEmail(text) {
  var found = String(text || '').match(EMAIL_RE) || [];
  for (var i = 0; i < found.length; i++) {
    var em = found[i].toLowerCase();
    var local = em.split('@')[0];
    var dom = em.split('@')[1] || '';
    if (EMAIL_DENY_LOCAL.indexOf(local) !== -1) continue;
    if (dom === 'example.com' || dom === 'test.com' || dom === 'localhost') continue;
    if (/\.png$|\.jpg$|\.jpeg$|\.gif$|\.svg$|\.webp$/.test(em)) continue;
    return em;
  }
  return '';
}

function withTimeout(promise, ms, label) {
  var timer;
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error(label + '超时（' + Math.round(ms / 1000) + ' 秒无响应）')); }, ms);
  });
  return Promise.race([promise, timeout]).then(function (v) { clearTimeout(timer); return v; },
    function (e) { clearTimeout(timer); throw e; });
}

function dsPost(url, apiKey, body, timeoutMs, label) {
  return withTimeout(fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (res) {
    return res.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON 报错体，按文本处理 */ }
      if (!res.ok) {
        var msg = (data && data.error && data.error.message) || t || ('HTTP ' + res.status);
        var err = new Error(String(msg).slice(0, 300));
        err.status = res.status;
        throw err;
      }
      return data;
    });
  }), timeoutMs, label);
}

// 把一条 Search 结果 + 抓到的官网文本拼成规范行（与 Excel 导入的规范行同形）。
//   fetchText 为 null 表示 Fetch 没拿到正文：只用搜索摘要当证据（前端硬规则照常审）。
//   搜索摘要和正文里都没有证据词时返回 null（这家丢弃，不进候选）。
function buildCompanyRow(result, fetchText, keyword, country) {
  var url = String((result && result.url) || '').trim();
  var domain = normalizeSearchDomain(url);
  if (!domain) return null;
  var summary = String((result && result.summary) || (result && result.snippet) || '').trim();
  var excerpt = '';
  if (fetchText) excerpt = findEvidenceExcerpt(fetchText, 500);
  if (!excerpt && summary) excerpt = findEvidenceExcerpt(summary, 500);
  if (!excerpt) return null; // 官网和搜索摘要里都找不到潜水料证据：不要
  var email = fetchText ? extractEmail(fetchText) : '';
  return {
    company: cleanCompanyName(result.title, result.site_name, domain),
    domain: domain,
    website: 'https://' + domain,
    country: country || '',
    size_text: '', size_min: null, size_max: null,
    evidence_url: url,
    evidence_excerpt: excerpt,
    evidence_level: '',
    product_category: keyword || '',
    industry: '', oem_text: '', activity_text: '',
    contact_name: '', contact_role: '',
    contact_email: email,
    email: email,
    phone: '', whatsapp: ''
  };
}

module.exports = async function (req, res) {
  var startedAt = Date.now();
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: '只接受 POST' });
  }
  var apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    return json(res, 500, { ok: false, error: '未配置 DeepSeek key：请在 Vercel 环境变量配置 DEEPSEEK_API_KEY（部署前就要配好）' });
  }
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
  }
  body = body || {};
  var keyword = String(body.keyword || '').trim();
  var country = String(body.country || '').trim();
  if (!keyword) return json(res, 400, { ok: false, error: '请填写关键词' });
  if (keyword.length > 100) return json(res, 400, { ok: false, error: '关键词太长（最多 100 字）' });
  if (country.length > 50) return json(res, 400, { ok: false, error: '国家太长（最多 50 字）' });

  var query = buildSearchQuery(keyword, country);
  var searchData;
  try {
    searchData = await dsPost(SEARCH_URL, apiKey,
      { query: query, count: SEARCH_COUNT, need_content: false },
      SEARCH_TIMEOUT_MS, 'DeepSeek 搜索');
  } catch (e) {
    // 402 余额不足 / 401 key 无效 / 429 限流：直接把原因报给前端，不让用户猜
    var hint = e.status === 402 ? 'DeepSeek 余额不足，请先充值'
      : e.status === 401 ? 'DeepSeek key 无效，请检查 Vercel 环境变量 DEEPSEEK_API_KEY'
      : e.status === 429 ? '搜索太频繁，请稍后再试'
      : 'DeepSeek 搜索失败：' + e.message;
    return json(res, 500, { ok: false, error: hint });
  }
  var results = (searchData && Array.isArray(searchData.results)) ? searchData.results : [];
  // 按域名去重，只留前 10 家（服务端硬上限；多要的 Search 结果到这里截掉）
  var seen = {}, picked = [];
  for (var i = 0; i < results.length && picked.length < PROSPECT_SEARCH_MAX_RESULTS; i++) {
    var d = normalizeSearchDomain(results[i] && results[i].url);
    if (!d || seen[d]) continue;
    seen[d] = true;
    picked.push(results[i]);
  }
  if (!picked.length) {
    return json(res, 200, {
      ok: true, companies: [], note: '没有搜到相关公司，换个关键词或国家再试一次。',
      meta: { keyword: keyword, country: country, query: query, found: 0, fetched: 0, dropped: 0, returned: 0 },
      searched_at: new Date().toISOString()
    });
  }
  // Fetch 每家官网核验：并行抓，单家 20 秒超时；整体超过软截止时不再等剩下的，
  // 没抓到的那几家只用搜索摘要当证据（前端硬规则照常审，不会因此放进无证据的公司）。
  var fetchJobs = picked.map(function (r) {
    return dsPost(FETCH_URL, apiKey, { url: String(r.url || '') }, FETCH_TIMEOUT_MS, 'DeepSeek Fetch')
      .then(function (page) { return (page && page.content) || ''; })
      .catch(function () { return null; });
  });
  var fetchDeadline = startedAt + DEADLINE_MS;
  var fetchResults;
  if (Date.now() >= fetchDeadline) {
    fetchResults = picked.map(function () { return null; });
  } else {
    var remaining = fetchDeadline - Date.now();
    fetchResults = await Promise.race([
      Promise.all(fetchJobs),
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, remaining); })
    ]);
    if (!fetchResults) fetchResults = picked.map(function () { return null; });
  }
  var companies = [], fetched = 0, dropped = 0;
  for (var j = 0; j < picked.length; j++) {
    if (fetchResults[j]) fetched++;
    var row = buildCompanyRow(picked[j], fetchResults[j], keyword, country);
    if (row) companies.push(row);
    else dropped++;
  }
  // 绝不把 key 写进日志或返回：只记关键词与条数
  console.log('prospect-search ok keyword=' + keyword + ' country=' + country +
    ' found=' + results.length + ' fetched=' + fetched + ' dropped=' + dropped +
    ' returned=' + companies.length);
  return json(res, 200, {
    ok: true,
    companies: companies,
    note: companies.length ? '' : '搜到了 ' + results.length + ' 条结果，但官网里都找不到明确的潜水料证据，换个关键词再试一次。',
    meta: {
      keyword: keyword, country: country, query: query,
      found: results.length, fetched: fetched, dropped: dropped, returned: companies.length
    },
    searched_at: new Date().toISOString()
  });
};

// Node 下测试用（浏览器/Vercel 里不执行）
module.exports._test = {
  PROSPECT_SEARCH_MAX_RESULTS: PROSPECT_SEARCH_MAX_RESULTS,
  SEARCH_COUNT: SEARCH_COUNT,
  EVIDENCE_WORDS: EVIDENCE_WORDS,
  buildSearchQuery: buildSearchQuery,
  normalizeSearchDomain: normalizeSearchDomain,
  cleanCompanyName: cleanCompanyName,
  findEvidenceExcerpt: findEvidenceExcerpt,
  extractEmail: extractEmail,
  buildCompanyRow: buildCompanyRow
};
