// 客户跟进工作台 — Vercel + Supabase 版（首版，按真实导出文件修订）
// 做法沿用工作面板 v2：不依赖任何外部 JS 库，直接用 fetch() 调 Supabase REST API，
// 每次请求 10 秒超时，失败只在对应列表报错，不会无限挂起。
//
// 数据来源：旧系统导出文件 Neoprene______2026-11-15.xlsx（2026-11-15 22:12:30 导出）：
//   客户档案 216 / 关联询盘 201 / 询盘跟进历史 310 / 跟进评估 216。
// 本文件不含任何示例客户：未配置 Supabase 或未导入时，列表为空并显示导入提示。
// 两个状态要分清（旧站就是这么算的）：
//   stage（当前阶段，原文）：新询盘 / 需求澄清 / 打样中 / 已报价 / 商务确认 / 暂缓 / 已关闭 / 已成交
//   reply_status（客户回复状态，原文）：已回复·待判断 / 未回复·等待客户 / 已回复·已处理
//   卡片数字由“下次跟进日期 + stage + reply_status”实时算出，与旧站首页一致：
//   今天应跟进 10 / 已逾期 106 / 回复待判断 122 / 等待客户 66 / 全部进行中 194。

// ---------- 可调规则（改这里即可，不用动其它代码） ----------
// 超过多少天无互动进“今日待办建议”（默认 7 天；GoodJob 跟进规则同款口径）。
// 注意：它不决定卡片上的“已逾期”——逾期只按“下次跟进日期过了今天”算，
// 否则实测会把 106 虚增到 110。见 computeInquiryStatus 的注释。
var OVERDUE_DAYS = 7;
// 你回了客户 / 确认了客户回复后，下次跟进默认往后推多少天
var FOLLOWUP_DELAY_DAYS = 3;
// v3 LaiFaXin 做法：写一条跟进，默认同时建一条待办，到期日 = 今天 + DEFAULT_TODO_DAYS 天。
// 与 FOLLOWUP_DELAY_DAYS 保持一致（都是 +3 天），改一处时另一处一起改。
var DEFAULT_TODO_DAYS = 3;
// v3 LaiFaXin 做法：导出每日上限（行数/天），与参考值一致；计数存在浏览器 localStorage（按天归零）。
var EXPORT_DAILY_CAP = 50000;
var EXPORT_COUNT_PREFIX = 'followup_export_'; // 后缀为 YYYY-MM-DD
// 每天扫描生成的待办最多几条（GoodJob 规则：每次最多 10 条，生成前先预览）
var MAX_TODOS_PER_RUN = 10;
// 健康度低于多少分算“需要关注”
var HEALTH_LOW = 60;
// 终态阶段：不计入“全部进行中”（旧站：194 = 201 − 暂缓 3 − 已关闭 3 − 已成交 1）
var TERMINAL_STAGES = ['已成交', '已关闭', '暂缓'];
// ---------- 搜客池 Phase 1（只收 Excel 名单，清洗 / 去重 / 打分 / 转客户；
//   不搜客、不验邮箱、不连来发信——“来发信 / DeepSeek / 手工导入”只是名单来源标签） ----------
// 分数门槛：≥80 优先（复核队列顶部，转客户后第一条待办 +3 天）；60-79 可跟进复核；
//   40-59 备选留池（不占待办）；<40 自动淘汰并记原因，下次搜到不再重复打分。
var SCORE_PRIORITY_MIN = 80;
var SCORE_REVIEW_MIN = 60;
var SCORE_DISCARD_MAX = 40;
// ---------- 项目与订单 / 经营汇总（与旧站经营汇总口径一致，见统计口径表） ----------
// 确认阶段：substring 匹配——“订单确认·返单”算确认，“打样·返单”不算。
// 45 条订单里确认 26 条；2026-11 有 2 笔（Kevin261031、kevin261102）。
var CONFIRMED_STAGE_KEYS = ['订单确认', '采购', '已出货', '已完成'];
// 订单阶段原文（45 条里实际出现的 9 个值；新建表单无数据时用这份兜底）。
var ORDER_STAGES = ['订单确认', '打样', '需求/报价', '采购/生产', '已出货', '已完成',
  '订单确认·返单', '打样·返单', '需求/报价·已签收'];

// ---------- Supabase 配置（从 config.js 读；部署时由 config.example.js 复制而来） ----------
// 同一个 Supabase 项目：neoprene-order-assistant（免费版已满 2 个项目，不新建，复用）
//   https://gplkvdodbfzknyafdttb.supabase.co
var FOLLOWUP_CONFIG = (typeof window !== 'undefined' && window.FOLLOWUP_CONFIG) || {};
var SUPABASE_URL = FOLLOWUP_CONFIG.SUPABASE_URL || 'https://gplkvdodbfzknyafdttb.supabase.co';
var SUPABASE_ANON_KEY = FOLLOWUP_CONFIG.SUPABASE_ANON_KEY || '__SUPABASE_ANON_KEY__';
var hasKey = SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== '__SUPABASE_ANON_KEY__' && SUPABASE_ANON_KEY !== 'PASTE_ANON_KEY_HERE';

// ---------- 状态 ----------
// 只有系统能确定的才自动分类；其余一律 intent='auto_unknown' + needs_review=true，
// 留在“回复待判断”里人工点一次。intent 取值与 supabase-followup.sql 的 CHECK 约束一致。
var INTENT_LABELS = {
  auto_unknown: '待判断', bounce: '退信', unsubscribe: '退订',
  reject: '明确拒绝', demand: '明确下单', quote: '要报价',
  sample: '要样品', price: '问价格', payment: '付款相关',
  address: '地址/电话', other: '其他'
};
// 旧站当前阶段（原文，行内编辑时可选）
var STAGES = ['新询盘', '需求澄清', '打样中', '已报价', '商务确认', '暂缓', '已关闭', '已成交'];
var STATUS_LABELS = {
  pending: '待处理', due: '今天应跟进', overdue: '已逾期', waiting: '等待客户',
  unscheduled: '待定日期', review: '回复待判断', done: '已成交', lost: '已丢单', archived: '归档'
};
var STATUS_BADGE = {
  pending: 'pending', due: 'due', overdue: 'overdue', waiting: 'waiting',
  unscheduled: 'pending', review: 'review', done: 'done', lost: 'overdue', archived: 'pending'
};
// 数据库 status 字符串 -> 计算用的 key（历史遗留值；新数据由日期 + stage 计算，status 列不作为依据）
var DB_STATUS_TO_KEY = {
  '待处理': 'pending', '今天应跟进': 'due', '已逾期': 'overdue', '等待客户': 'waiting',
  '待定日期': 'unscheduled', '回复待判断': 'review', '已成交': 'done', '已丢单': 'lost', '归档': 'archived'
};

var state = { customers: [], inquiries: [], emails: [], syncState: null, orders: [], suppliers: [], history: [], prospects: [], prospectBatches: [], prospectContacts: [], prospectCoverage: [] };
var currentView = 'workbench';
var currentFilter = 'all';
var searchText = '';
var customerSearchText = '';
var allSearchText = '';
// 项目与订单页筛选（类型 = 阶段在“·”之前的部分，如“订单确认·返单”属“订单确认”）
var orderTypeFilter = '';
var orderCustomerFilter = '';
var orderStageFilter = '';
var orderSearchText = '';
var orderFilterSig = ''; // 类型/客户/阶段下拉选项的签名，数据不变时不重建选项
// 供应商与物流页筛选
var supplierSearchText = '';
var supplierKindFilter = '';
// 经营汇总页月份（默认取数据里最晚的有活动月份）
var summaryMonth = '';
var summaryMonthSig = '';
// 客户档案页筛选 / 批量选择（旧系统样式：搜索 + 类型 + 等级 + 批量删除）
var customerTypeFilter = '';
var customerGradeFilter = '';
var selectedCustomerIds = {}; // id -> true，跨搜索/筛选保留
var customerFilterSig = ''; // 类型/等级下拉选项的签名，数据不变时不重建选项
var editingId = null; // 正在行内编辑的询盘 id
var lastSyncSummaryText = ''; // 本次会话刚同步完的完整结果行；loadAll 刷新时保留它，不被“上次同步”盖掉
// 搜客池筛选 / 待确认的导入（预览后点确认才写库）
var prospectCountryFilter = '';
var prospectBandFilter = '';
var prospectStatusFilter = '';
var prospectBatchFilter = '';
var prospectSearchText = '';
var prospectFilterSig = ''; // 国家/批次下拉选项的签名，数据不变时不重建选项
var pendingProspectImport = null; // { rows, mapping, meta, result }：预览待确认的一批

// ---------- 纯函数（不碰 DOM；Node 下可通过 module.exports 单独测试） ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function todayStr(d) {
  var t = d || new Date();
  var y = t.getFullYear();
  var m = String(t.getMonth() + 1).padStart(2, '0');
  var day = String(t.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function fmtDate(d) { return d ? String(d).slice(0, 10) : '—'; }
function addDays(dateStr, n) {
  var d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
function daysBetween(fromStr, toStr) {
  if (!fromStr || !toStr) return null;
  var a = new Date(String(fromStr).slice(0, 10) + 'T00:00:00');
  var b = new Date(String(toStr).slice(0, 10) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
function isTerminalStage(stage) { return TERMINAL_STAGES.indexOf(stage || '') !== -1; }

// ---------- v3 LaiFaXin 做法：验证状态 / 标签 / 去重 / 导出上限（纯函数，可单测） ----------
// 邮箱验证状态：valid 有效 / unknown 未知 / invalid 无效 / verifying 验证中 / unverified 未验证。
// 只有 valid / unknown 以后可群发（群发在来发信里做，本系统不发群发邮件）。
var VERIFICATION_LABELS = {
  valid: '有效', unknown: '未知', invalid: '无效', verifying: '验证中', unverified: '未验证'
};
// 免费邮箱域名：域名去重时排除——几十个客户都用 gmail.com 不能算同一家公司。
var FREE_EMAIL_DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
  'qq.com', '163.com', '126.com', 'foxmail.com', 'sina.com', 'live.com', 'msn.com', 'aol.com',
  'mail.com', 'proton.me', 'protonmail.com', 'bk.ru', 'mail.ru', 'yandex.ru'];
function emailDomain(e) {
  var parts = normalizeEmail(e).split('@');
  return parts.length === 2 ? parts[1] : '';
}
function isFreeDomain(d) { return FREE_EMAIL_DOMAINS.indexOf(d) !== -1; }
// 保存前去重：在已有客户里找重复。命中条件（二选一）：
//   1) 邮箱小写后完全相同；2) 同一家公司（公司名小写去空格相同）且邮箱域名相同、域名不是免费邮箱。
// 返回已存在的客户对象，未命中返回 null。导入脚本里是同一规则的 Python 版。
function findDuplicateCustomer(customers, email, company) {
  var em = normalizeEmail(email);
  var co = String(company || '').trim().toLowerCase().replace(/\s+/g, ' ');
  var dom = emailDomain(em);
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    if (em && normalizeEmail(c.email) === em) return c;
    if (co && dom && !isFreeDomain(dom) &&
        String(c.company || '').trim().toLowerCase().replace(/\s+/g, ' ') === co &&
        emailDomain(c.email) === dom) return c;
  }
  return null;
}
// 标签：数据库里是 text[]，前端表单里是逗号分隔的文本；两种都接受，统一返回去重后的数组。
// 命名约定：产品｜行业｜年月，例如 NEO-WS｜潜水服水上运动｜2026-08；另可加来源标签。
function normalizeTags(tags) {
  var arr = [];
  if (Array.isArray(tags)) arr = tags;
  else if (typeof tags === 'string') arr = tags.split(',');
  else return [];
  var seen = {};
  var out = [];
  arr.forEach(function (t) {
    var s = String(t || '').trim();
    if (s && !seen[s]) { seen[s] = true; out.push(s); }
  });
  return out;
}
function tagsToString(tags) { return normalizeTags(tags).join(', '); }
// 导出上限检查（纯函数）：今日已导出 used 行，本次要导 rows 行，上限 cap 行。
// 返回 { ok: bool, remaining: number }；ok 为 false 时调用方直接拦截并提示，不导出。
function checkExportCap(usedToday, rowsToExport, cap) {
  var used = Math.max(0, parseInt(usedToday, 10) || 0);
  var rows = Math.max(0, parseInt(rowsToExport, 10) || 0);
  var limit = parseInt(cap, 10) || EXPORT_DAILY_CAP;
  return { ok: used + rows <= limit, remaining: Math.max(0, limit - used) };
}
function exportCountKey(dateStr) { return EXPORT_COUNT_PREFIX + (dateStr || todayStr()); }
function verificationLabel(v) { return VERIFICATION_LABELS[v] || VERIFICATION_LABELS.unverified; }

// ---------- 搜客池 Phase 1：硬规则 / 打分 / 去重（纯函数，不碰 DOM；Node 下可单测） ----------
// 规则来源：goodjob-adaptation-plan.pdf 第 5-6 页。顺序：硬规则在前（一条不过直接淘汰，
//   不进打分、不重复收费），100 分打分在后（只按导入的结构化字段算，缺字段那一维记 0，
//   绝不编造）。三铁方向原按 PDF 第 5 页“新搜客不碰 triathlon”做硬淘汰；
//   2026-11-21 23:20 用户放宽：只拦主营三铁的公司（公司名/产品类别/行业里带三铁），
//   潜水服厂在官网罗列三铁只是其中一项运动时不拦（见 checkProspectHardRules）。
// 产品线类别（PDF 第 5 页）：片材线 + 成品线 7 类；命中其中之一 = 产品匹配满分。
var PROSPECT_EXACT_CATEGORIES = ['潜水服', 'wetsuit', '袖套', '护具', '包袋', '鞋帽', '手套',
  '宠物', '汽车用品', '运动配件', '片材', 'sheet', '潜水料', '氯丁橡胶片材', 'neoprene sheet'];
// 相邻品类：同材质、不同产品（不在两条产品线里，但确实是潜水料制品）。
var PROSPECT_ADJACENT_CATEGORIES = ['瑜伽', '鼠标垫', '杯套', '相机包', '电脑包', '潜水靴', '潜水帽',
  '腰带', '护膝', '护肘', '泳帽', '耳带', 'yoga', 'mousepad', 'cooler', 'koozie'];
// 潜水料证据词（硬规则用）：摘录或证据链接里出现任一词 = 有明确证据。
var PROSPECT_EVIDENCE_WORDS = ['neoprene', 'chloroprene', '氯丁橡胶', '潜水料', 'wetsuit material', 'cr sheet', 'sbr sheet'];
// 工业用途词（硬规则用）：命中即淘汰，哪怕证据明确。只放不会跟民用产品撞车的词
//   （如“密封件/化工厂/采矿”）；“汽车”不放——汽车用品是民用白名单里的品类。
var PROSPECT_INDUSTRIAL_WORDS = ['industrial', '工业用途', '工业用', 'gasket', '密封件', '化工厂',
  'chemical plant', 'mining', '采矿', 'pipeline', 'hvac', '汽车零部件', '隔热材料', 'insulation material'];
// 三铁方向：只拦主营三铁的公司（2026-11-21 23:20 用户放宽；原 PDF 第 5 页“新搜客
//   不碰 triathlon”是凡提及就拦，试搜西班牙时把 Kynay、Ocean Tailored 这类做十几种
//   水上运动潜水服的厂也拦掉了）。判断只看公司名/产品类别/行业，不看证据摘录。
var PROSPECT_TRIATHLON_WORDS = ['triathlon', '三铁', '铁人三项'];
// 排除国家：日本、中国（含港澳台）。国家名 + 域名后缀两道检查。
var PROSPECT_EXCLUDED_COUNTRIES = ['日本', 'japan', '中国', 'china', '香港', 'hong kong', '澳门', 'macau', '台湾', 'taiwan'];
var PROSPECT_EXCLUDED_DOMAIN_SUFFIXES = ['.jp', '.cn', '.hk', '.mo', '.tw'];
// 通用邮箱前缀（只有这类邮箱 = 7 分）；决策人职位词（具名邮箱 = 15 分）。
var GENERIC_EMAIL_PREFIXES = ['info', 'sales', 'contact', 'support', 'hello', 'office', 'admin', 'mail', 'enquiry', 'inquiry'];
var DECISION_MAKER_ROLES = ['founder', 'ceo', 'owner', '创始人', '总经理', '董事', 'president',
  'managing director', '采购', '产品经理', 'purchasing', 'procurement', 'product manager', 'sourcing'];
// 僵尸站信号：规模与活跃度那一维直接扣到 3 分。
var PROSPECT_STALE_WORDS = ['僵尸', '停滞', '未更新', 'stale', 'inactive', 'dead site'];

function containsWord(haystack, words) {
  var h = String(haystack || '').toLowerCase();
  for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) !== -1) return words[i];
  return null;
}
// 站内搜索（Phase 2）：关键词 + 国家调 /api/prospect-search（DeepSeek），结果复用导入预览/确认流程。
var PROSPECT_SEARCH_MAX_RESULTS = 10;
var PROSPECT_SEARCH_SUGGESTIONS = ['定制潜水服', '氯丁橡胶潜水服', '潜水装备', '冲浪潜水服'];
// 站内搜索导入元数据：与 Excel 导入同一结构（国家/关键词组/来源）。
function prospectSearchImportMeta(keyword, country) {
  return { country: String(country || '').trim(), keywordGroup: String(keyword || '').trim(), source: '站内搜索' };
}
// 规范化站内搜索返回的公司行：服务端行与 normalizeProspectRow 输出同构，只取已给字段（不编造），
//   最多取 PROSPECT_SEARCH_MAX_RESULTS 家，来源统一标为站内搜索。
function normalizeProspectSearchCompanies(companies) {
  if (!Array.isArray(companies)) return [];
  return companies.slice(0, PROSPECT_SEARCH_MAX_RESULTS).map(function (c) {
    var row = normalizeProspectRow(c || {});
    row.source = '站内搜索';
    return row;
  });
}
// 域名归一化：去协议、去 www、去路径/参数、小写。空返回 ''。
function normalizeDomain(d) {
  var s = String(d || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0].trim();
  return s;
}
// 公司名归一化（去重用）：小写、去空格标点、去尾部公司后缀。
function normalizeCompanyName(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\.,&'’\-_/()（）【】\[\]]+/g, '')
    .replace(/(limited|ltd|inc|llc|gmbh|pty|bv|sas|sa|ag|kk|company|有限|公司)$/g, '');
}
// 规模解析：字段可能是 "11-50"、"50"、"11–50 人"，或 size_min/size_max 两列。
// 返回 { min, max } 或 null（未提供——硬规则不淘汰，打分那一维记 0）。
function parseProspectSize(sizeText, sizeMin, sizeMax) {
  var nums = String(sizeText || '').match(/\d+/g);
  var min = (sizeMin !== null && sizeMin !== undefined && sizeMin !== '') ? parseInt(sizeMin, 10) : null;
  var max = (sizeMax !== null && sizeMax !== undefined && sizeMax !== '') ? parseInt(sizeMax, 10) : null;
  if ((min === null || isNaN(min)) && nums && nums.length) min = parseInt(nums[0], 10);
  if ((max === null || isNaN(max)) && nums && nums.length > 1) max = parseInt(nums[1], 10);
  if (min === null || isNaN(min)) min = null;
  if (max === null || isNaN(max)) max = null;
  if (min === null && max === null) return null;
  if (max === null) max = min;
  if (min === null) min = max;
  return { min: min, max: max };
}

// 硬规则（一条不过直接淘汰，不进打分；返回 { ok, reason }，reason 为中文淘汰原因）。
// 检查顺序：证据 → 用途（含三铁）→ 国家 → 官网。
function checkProspectHardRules(row) {
  var evidenceText = (row.evidence_excerpt || '') + ' ' + (row.evidence_url || '');
  var useText = (row.product_category || '') + ' ' + (row.industry || '') + ' ' + (row.evidence_excerpt || '');
  var domain = normalizeDomain(row.domain || row.website || '');
  var country = String(row.country || '').trim();
  // 1) 证据：摘录含潜水料词，或证据位置是图片质感判断（摘录里写了质感）。
  var hasEvidence = !!containsWord(evidenceText, PROSPECT_EVIDENCE_WORDS) ||
    (row.evidence_level === 'image' && String(row.evidence_excerpt || '').trim() !== '');
  if (!hasEvidence) return { ok: false, reason: '无明确潜水料证据' };
  // 2) 用途：只留民用、商用；工业用途淘汰（哪怕证据明确）；三铁只拦主营。
  //   主营判断只看公司名/产品类别/行业：证据摘录里顺带提到三铁（例如潜水服厂
  //   官网罗列的运动项目里有三铁）不拦——2026-11-21 西班牙试搜 Kynay 就是这么放进来的。
  var ind = containsWord(useText, PROSPECT_INDUSTRIAL_WORDS);
  if (ind) return { ok: false, reason: '工业用途：' + ind };
  var mainText = (row.company || '') + ' ' + (row.product_category || '') + ' ' + (row.industry || '');
  var tri = containsWord(mainText, PROSPECT_TRIATHLON_WORDS);
  if (tri) return { ok: false, reason: '主营三铁：' + tri };
  // 3) 国家：排除日本、中国（含港澳台域名）。
  if (containsWord(country, PROSPECT_EXCLUDED_COUNTRIES)) return { ok: false, reason: '国家排除：' + country };
  var suffixHit = null;
  PROSPECT_EXCLUDED_DOMAIN_SUFFIXES.forEach(function (s) { if (domain && domain.endsWith(s)) suffixHit = s; });
  if (suffixHit) return { ok: false, reason: '国家排除：域名后缀 ' + suffixHit };
  // 4) 官网：一人作坊 / 无官网只有社媒的淘汰（域名和网址都空 = 无官网）。
  if (!domain) return { ok: false, reason: '无官网（只有社媒或无网址）' };
  return { ok: true, reason: '' };
}

// 从导入的结构化字段推断打分信号（只分类已提供的字段，不编造；推断不出 = ''，对应维度记 0）。
// 证据位置：文件里有 证据位置 列就直接用；没有就从摘录关键词推断；摘录有潜水料证据但
//   看不出位置时默认 product_page（25 分）——摘录本身就是从网站产品内容里摘的，
//   这是分类已提供的数据，不是编造新证据；位置完全无法判断又无摘录的行，
//   硬规则已在前面淘汰，不会走到这里。
function detectProspectSignals(row) {
  var text = ((row.evidence_excerpt || '') + ' ' + (row.evidence_url || '')).toLowerCase();
  var cat = String(row.product_category || '').toLowerCase();
  var catText = cat + ' ' + text;
  var oemText = ((row.oem_text || '') + ' ' + (row.evidence_excerpt || '')).toLowerCase();
  var level = row.evidence_level || '';
  if (!level) {
    if (/(blog|博客|新闻|news)/.test(text)) level = 'blog';
    else if (/(图片|质感|texture|matte)/.test(text)) level = 'image';
    else if (/(在售|add to cart|buy now|立即购买|加入购物车|checkout)/.test(text)) level = 'site_sale';
    else level = 'product_page';
  }
  var fit = containsWord(catText, PROSPECT_EXACT_CATEGORIES) ? 'exact'
    : (containsWord(catText, PROSPECT_ADJACENT_CATEGORIES) ? 'adjacent' : '');
  var productLine = /(片材|sheet|foam|发泡)/.test(catText) ? '片材' : '成品';
  var oem = /(custom|oem|private label|wholesale|定制|代工|批发|odm)/.test(oemText) ? 'oem'
    : (/(retail|零售|专卖店)/.test(oemText) ? 'retail' : '');
  var email = normalizeEmail(row.contact_email || row.email || '');
  var role = String(row.contact_role || '').toLowerCase();
  var generic = !!email && GENERIC_EMAIL_PREFIXES.indexOf(email.split('@')[0]) !== -1;
  var isDM = !!containsWord(role, DECISION_MAKER_ROLES);
  // 具名决策人邮箱 15 分；只有通用邮箱 7 分；无邮箱 0 分（且不能转客户）。
  // 具名但职位不在决策人清单里（如 Sales Manager）按 7 分计——规格只认了上述职位，
  // 不替文件里没写的职位背书。
  var contactType = !email ? 'none' : ((isDM && !generic) ? 'named' : 'generic');
  var size = parseProspectSize(row.size_text, row.size_min, row.size_max);
  var stale = !!containsWord(row.activity_text || '', PROSPECT_STALE_WORDS);
  var sizeBand = '';
  if (size) {
    if (size.min >= 11 && size.max <= 200) sizeBand = 'mid';
    else sizeBand = 'edge';
  }
  var hasPhone = !!(String(row.phone || '').trim() || String(row.whatsapp || '').trim());
  var contactComplete = !email ? 'none' : (hasPhone ? 'full' : 'email_only');
  return {
    evidenceLevel: level, productFit: fit, productLine: productLine, oemSignal: oem,
    contactType: contactType, sizeBand: sizeBand, siteStale: stale, contactComplete: contactComplete
  };
}

// 100 分打分（只做算术，不查任何外部数据；缺字段的维度记 0）。
function scoreProspect(s) {
  var parts = {
    evidence: s.evidenceLevel === 'site_sale' ? 35 : s.evidenceLevel === 'product_page' ? 25
      : s.evidenceLevel === 'blog' ? 10 : s.evidenceLevel === 'image' ? 15 : 0,
    fit: s.productFit === 'exact' ? 20 : s.productFit === 'adjacent' ? 10 : 0,
    oem: s.oemSignal === 'oem' ? 15 : s.oemSignal === 'retail' ? 5 : 0,
    contact: s.contactType === 'named' ? 15 : s.contactType === 'generic' ? 7 : 0,
    size: s.siteStale ? 3 : (s.sizeBand === 'mid' ? 10 : s.sizeBand === 'edge' ? 7 : 0),
    completeness: s.contactComplete === 'full' ? 5 : s.contactComplete === 'email_only' ? 3 : 0
  };
  var total = parts.evidence + parts.fit + parts.oem + parts.contact + parts.size + parts.completeness;
  return { total: total, parts: parts, needsHumanCheck: s.evidenceLevel === 'image' };
}
// 分档：≥80 优先 / 60-79 可跟 / 40-59 备选 / <40 淘汰。
function scoreBand(total) {
  if (total >= SCORE_PRIORITY_MIN) return '优先';
  if (total >= SCORE_REVIEW_MIN) return '可跟';
  if (total >= SCORE_DISCARD_MAX) return '备选';
  return '淘汰';
}
// 定档：≥60 待复核 / 40-59 已保留（备选，留池不占待办）/ <40 已淘汰（记原因）。
function classifyProspect(total, discardReason) {
  if (total < SCORE_DISCARD_MAX) {
    return { status: '已淘汰', reason: (discardReason || '分数低于 ' + SCORE_DISCARD_MAX + ' 分（证据/匹配不足）') };
  }
  if (total >= SCORE_REVIEW_MIN) return { status: '待复核', reason: '' };
  return { status: '已保留', reason: '' };
}

// 搜客池去重：三重检查，对客户档案 + 搜客池（含已淘汰）同时查。
//   命中任一即跳过，并记原因。免费邮箱域名不算域名去重（几十家公司都用 gmail）。
//   公司名判重需国家相同（同名不同国家的公司不算同一家；任一国家为空时只按公司名判）。
// records 是 { email, company, website, country } 的数组；label 是 '客户档案' 或 '搜客池'。
// 返回 { kind, where, matched }，未命中返回 null。
function findProspectDuplicate(row, customers, candidates) {
  var email = normalizeEmail(row.contact_email || row.email || '');
  var domain = normalizeDomain(row.domain || row.website || '');
  var emailDom = emailDomain(email);
  var company = normalizeCompanyName(row.company || '');
  var country = String(row.country || '').trim().toLowerCase();
  var recEmail = function (r) { return normalizeEmail(r.email || r.contact_email || ''); };
  var recDomain = function (r) { return normalizeDomain(r.website || r.domain || ''); };
  var recEmailDom = function (r) { return emailDomain(recEmail(r)); };
  var lists = [
    { rows: customers || [], where: '客户档案' },
    { rows: candidates || [], where: '搜客池' }
  ];
  for (var li = 0; li < lists.length; li++) {
    var rows = lists[li].rows, where = lists[li].where;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var display = r.company || r.name || recEmail(r) || recDomain(r) || '';
      // 1) 邮箱完全相同
      if (email && recEmail(r) === email) return { kind: '邮箱', where: where, matched: display };
      // 2) 域名相同：网站域名，或非免费邮箱域名
      if (domain && recDomain(r) === domain) return { kind: '域名', where: where, matched: display };
      if (domain && emailDom && !isFreeDomain(emailDom) && recEmailDom(r) === emailDom) {
        return { kind: '邮箱域名', where: where, matched: display };
      }
      if (emailDom && !isFreeDomain(emailDom) && recDomain(r) === emailDom) {
        return { kind: '邮箱域名', where: where, matched: display };
      }
      // 3) 公司名相同且国家相同（任一国家为空时只按公司名判）
      var rc = normalizeCompanyName(r.company || '');
      if (company && rc === company) {
        var rCountry = String(r.country || '').trim().toLowerCase();
        if (!country || !rCountry || country === rCountry) {
          return { kind: '公司名', where: where, matched: display };
        }
      }
    }
  }
  return null;
}

// 导入列名自动识别：中英文表头同义词（键一律小写后查）。返回 { 字段名: 原表头 }。
var PROSPECT_COLUMN_MAP = {
  '公司': 'company', 'company': 'company', '公司名称': 'company', '企业': 'company',
  '域名': 'domain', 'domain': 'domain', '网址': 'domain', '网站': 'domain', 'website': 'domain',
  '官网': 'website', '官网地址': 'website',
  '国家': 'country', '国家/地区': 'country', 'country': 'country',
  '规模': 'size_text', '员工数': 'size_text', '人数': 'size_text', 'size': 'size_text', 'employees': 'size_text',
  '邮箱': 'email', 'email': 'email', '邮件': 'email',
  '联系人': 'contact_name', 'contact': 'contact_name', '姓名': 'contact_name', 'name': 'contact_name',
  '职位': 'contact_role', 'title': 'contact_role', '职务': 'contact_role', 'role': 'contact_role',
  '电话': 'phone', '手机': 'phone', 'phone': 'phone', 'tel': 'phone',
  'whatsapp': 'whatsapp',
  '证据链接': 'evidence_url', '证据': 'evidence_url', 'evidence': 'evidence_url', '链接': 'evidence_url', 'url': 'evidence_url',
  '证据摘录': 'evidence_excerpt', '证据摘要': 'evidence_excerpt', '摘录': 'evidence_excerpt', 'excerpt': 'evidence_excerpt',
  '证据位置': 'evidence_level', '证据类型': 'evidence_level', 'evidence_level': 'evidence_level',
  '产品类别': 'product_category', '产品': 'product_category', 'category': 'product_category', 'product': 'product_category', '品类': 'product_category',
  '行业': 'industry', 'industry': 'industry',
  '定制信号': 'oem_text', 'oem': 'oem_text', '定制': 'oem_text',
  '活跃': 'activity_text', '最近更新': 'activity_text', '更新': 'activity_text'
};
function detectProspectColumns(headers) {
  var map = {};
  (headers || []).forEach(function (h) {
    var key = String(h || '').trim().toLowerCase();
    var f = PROSPECT_COLUMN_MAP[key];
    if (f && !map[f]) map[f] = String(h).trim();
  });
  return map;
}
// 把一行原始导入行按识别出的列映射转成规范字段。
// 证据位置列的值可能是中文（官网在售/产品页/博客/图片），统一转成内部取值。
function normalizeProspectRow(raw, mapping) {
  var o = {};
  Object.keys(mapping || {}).forEach(function (f) {
    var h = mapping[f];
    var v = raw ? raw[h] : '';
    o[f] = (v === null || v === undefined) ? '' : String(v).trim();
  });
  var lv = String(o.evidence_level || '').toLowerCase();
  o.evidence_level = (lv.indexOf('在售') !== -1 || lv === 'site_sale' || lv === 'site') ? 'site_sale'
    : (lv.indexOf('产品页') !== -1 || lv === 'product_page' || lv === 'product') ? 'product_page'
    : (lv.indexOf('博客') !== -1 || lv.indexOf('新闻') !== -1 || lv === 'blog' || lv === 'news') ? 'blog'
    : (lv.indexOf('图片') !== -1 || lv.indexOf('质感') !== -1 || lv === 'image') ? 'image' : '';
  o.contact_email = o.email || '';
  o.domain = normalizeDomain(o.domain || o.website || '');
  return o;
}
// 把规范行拼成直接写 prospect_candidates 的记录（不含 id / batch_id，写库时再补）。
function buildProspectCandidate(row, signals, scored, status) {
  var size = parseProspectSize(row.size_text, row.size_min, row.size_max);
  return {
    company: row.company || '', domain: normalizeDomain(row.domain || row.website || ''),
    website: row.website || (row.domain ? 'https://' + normalizeDomain(row.domain) : ''),
    country: row.country || '', size_min: size ? size.min : null, size_max: size ? size.max : null,
    size_text: row.size_text || '', evidence_url: row.evidence_url || '',
    evidence_excerpt: row.evidence_excerpt || '', evidence_level: signals.evidenceLevel || '',
    product_category: row.product_category || '', product_line: signals.productLine || '',
    industry: row.industry || '', oem_signal: signals.oemSignal || '', contact_type: signals.contactType || '',
    score_total: scored.total, score_evidence: scored.parts.evidence, score_fit: scored.parts.fit,
    score_oem: scored.parts.oem, score_contact: scored.parts.contact, score_size: scored.parts.size,
    score_completeness: scored.parts.completeness, needs_human_check: scored.needsHumanCheck,
    status: status, discard_reason: '', verification_status: 'unverified',
    contact_name: row.contact_name || '', contact_role: row.contact_role || '',
    contact_email: normalizeEmail(row.contact_email || row.email || ''),
    contact_phone: row.phone || '', contact_whatsapp: row.whatsapp || ''
  };
}
// 一批导入行的清洗结果（纯函数，不碰 DOM/网络）：
//   每行依次：硬规则 → 去重（客户档案 + 搜客池含已淘汰 + 本批已入池的）→ 打分 → 定档。
// 返回 { pooled: [候选记录...], rejected: [{ row, reason }], skipped: [{ row, reason }] }。
// 被淘汰 / 跳过的行只记原因，不写库、不再重复打分；其中 <40 分的淘汰原因里带分数。
function processProspectImport(rows, customers, candidates) {
  var pooled = [], rejected = [], skipped = [];
  var batchSeen = [];
  (rows || []).forEach(function (raw) {
    var row = raw; // 调用方已用 normalizeProspectRow 规范过
    if (!String(row.company || '').trim() && !row.domain) {
      rejected.push({ row: row, reason: '无公司名也无域名' });
      return;
    }
    var hard = checkProspectHardRules(row);
    if (!hard.ok) { rejected.push({ row: row, reason: hard.reason }); return; }
    var dup = findProspectDuplicate(row, customers, candidates);
    if (!dup) {
      var dupInBatch = findProspectDuplicate(row, batchSeen, []);
      if (dupInBatch) dup = { kind: dupInBatch.kind, where: '本批', matched: dupInBatch.matched };
    }
    if (dup) {
      skipped.push({ row: row, reason: dup.kind + '已存在于' + dup.where + '：' + dup.matched });
      return;
    }
    var signals = detectProspectSignals(row);
    var scored = scoreProspect(signals);
    var cls = classifyProspect(scored.total, '');
    if (cls.status === '已淘汰') {
      rejected.push({ row: row, reason: cls.reason + '（' + scored.total + ' 分）' });
      return;
    }
    pooled.push(buildProspectCandidate(row, signals, scored, cls.status));
    batchSeen.push(row);
  });
  return { pooled: pooled, rejected: rejected, skipped: skipped };
}
// 覆盖记忆判重（纯函数）：同一国家+关键词组之前搜过就返回那条记录（只提示，不拦截）。
function findProspectCoverageHit(country, keywordGroup, coverageRows) {
  var c = String(country || '').trim().toLowerCase();
  var k = String(keywordGroup || '').trim().toLowerCase();
  if (!c && !k) return null;
  for (var i = 0; i < (coverageRows || []).length; i++) {
    var r = coverageRows[i];
    if (String(r.country || '').trim().toLowerCase() === c &&
        String(r.keyword_group || '').trim().toLowerCase() === k) return r;
  }
  return null;
}

// 计算一条询盘的跟进桶（返回 key）。
// 优先级：终态阶段（已成交/已关闭/暂缓）> 下次跟进日期 > 库里显式状态 > 距最后联系天数。
// 回复状态不参与这一列的计算：待判断 / 等待客户是另一维度的卡片，见 computeCards。
function computeInquiryStatus(inq, cust, today) {
  var t = today || todayStr();
  if (isTerminalStage(inq.stage)) return inq.stage === '已成交' ? 'done' : 'archived';
  var dbKey = DB_STATUS_TO_KEY[inq.status] || 'pending';
  if (dbKey === 'done' || dbKey === 'lost' || dbKey === 'archived') return dbKey;
  var next = inq.next_followup_at ? String(inq.next_followup_at).slice(0, 10) : '';
  if (next) {
    if (next < t) return 'overdue';
    if (next === t) return 'due';
    return 'pending';
  }
  // 无下次跟进日期 = 待定日期（旧站口径；15 条空日期与“日期已手动确认=否”一一对应）。
  // 注意：不要在这里用“超过 7 天无互动”推断逾期——实测会把逾期从 106 虚增到 110，
  // 与旧站首页对不上。7 天规则只进 buildTodos 的待办建议，不进卡片数字。
  return 'unscheduled';
}

function computeCards(customers, inquiries, emails, today) {
  var t = today || todayStr();
  var byId = {};
  customers.forEach(function (c) { byId[c.id] = c; });
  var cards = { due: 0, overdue: 0, review: 0, waiting: 0, pending: 0, unscheduled: 0, total: 0 };
  var reviewIds = {};
  inquiries.forEach(function (inq) {
    if (isTerminalStage(inq.stage)) return; // 终态不计入“进行中”
    var key = computeInquiryStatus(inq, byId[inq.customer_id], t);
    if (key === 'done' || key === 'lost' || key === 'archived') return;
    cards.total++;
    if (cards[key] !== undefined) cards[key]++;
    // 回复待判断：按 reply_status 计，排除终态（旧站：126 − 暂缓 2 − 已关闭 2 = 122）
    if (inq.reply_status === '已回复 · 待判断') reviewIds[inq.id] = true;
    // 等待客户：按 reply_status 计，排除终态（旧站：67 − 暂缓 1 = 66）
    if (inq.reply_status === '未回复 · 等待客户') cards.waiting++;
  });
  // 邮箱同步后新到的未判断邮件：所归属的询盘尚未被 reply_status 覆盖时也计入（按询盘去重）
  emails.forEach(function (e) {
    if (!e.needs_review) return;
    if (e.inquiry_id) reviewIds[e.inquiry_id] = true;
    else reviewIds['email:' + e.id] = true;
  });
  cards.review = Object.keys(reviewIds).length;
  return cards;
}

// 今日待办建议：每天扫描一次，最多 MAX_TODOS_PER_RUN 条，每条写清为什么 + 下一步。
// 触发条件（任一即入选）：已逾期 / 超过 OVERDUE_DAYS 天无互动 / 健康度 < HEALTH_LOW / 缺下一步动作。
function buildTodos(customers, inquiries, today) {
  var t = today || todayStr();
  var byId = {};
  customers.forEach(function (c) { byId[c.id] = c; });
  var todos = [];
  var seen = {};
  inquiries.forEach(function (inq) {
    if (isTerminalStage(inq.stage)) return;
    var cust = byId[inq.customer_id] || { name: '', company: '', health_score: 50 };
    var key = computeInquiryStatus(inq, cust, t);
    if (key === 'done' || key === 'lost' || key === 'archived') return;
    var last = inq.last_reply_at || inq.last_contact_at || cust.last_contact_at || inq.first_inquiry_at;
    var gap = daysBetween(last, t);
    var reasons = [];
    if (key === 'overdue') reasons.push('已逾期' + (gap !== null ? gap + ' 天无互动' : ''));
    else if (gap !== null && gap >= OVERDUE_DAYS) reasons.push(gap + ' 天无互动');
    if (!inq.next_action && !(cust && cust.next_action)) reasons.push('缺下一步动作');
    if ((cust.health_score ?? 50) < HEALTH_LOW) reasons.push('健康度仅 ' + (cust.health_score ?? 50) + ' 分（低于 ' + HEALTH_LOW + ' 分）');
    if (!reasons.length) return;
    var fingerprint = inq.id + '|' + reasons.join('|');
    if (seen[fingerprint]) return;
    seen[fingerprint] = true;
    todos.push({
      inquiry_id: inq.id, customer_id: inq.customer_id,
      customer: cust.company || cust.name || '未知客户',
      product: inq.product || '',
      reason: reasons.join('；'),
      next_action: inq.next_action || cust.next_action || '先看客户最新回复，再决定下一步',
      due: inq.next_followup_at ? String(inq.next_followup_at).slice(0, 10) : t,
      overdue: key === 'overdue',
      fingerprint: fingerprint
    });
  });
  todos.sort(function (a, b) { return (b.overdue - a.overdue) || (a.due < b.due ? -1 : 1); });
  return todos.slice(0, MAX_TODOS_PER_RUN);
}

// ---------- 经营汇总（纯函数；口径见 import/Neoprene_经营汇总_2026_11月.xlsx 的“统计口径”表，全部现算，不写死数字） ----------
// 确认订单：阶段含 订单确认 / 采购 / 已出货 / 已完成（substring；“订单确认·返单”算，“打样·返单”不算）。
function isConfirmedOrder(o) {
  var s = String((o && o.stage) || '');
  for (var i = 0; i < CONFIRMED_STAGE_KEYS.length; i++) if (s.indexOf(CONFIRMED_STAGE_KEYS[i]) !== -1) return true;
  return false;
}
// 已取消的订单不进销售额；当前 9 个阶段值里没有“取消”，留作口径（以后出现“取消”阶段自动排除）。
function isCancelledOrder(o) { return String((o && o.stage) || '').indexOf('取消') !== -1; }
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
// 逐单折算：美元金额 × 本单汇率，四舍五入到分；金额或汇率缺失不算 0，返回 null（待补）。
function orderCny(o) {
  var amt = toNum(o.amount_usd), rate = toNum(o.exchange_rate);
  if (amt === null || rate === null) return null;
  return round2(amt * rate);
}
function fmtUSD(n) {
  if (n === null || n === undefined) return '—';
  return 'US$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCNY(n) {
  if (n === null || n === undefined) return '—';
  return '¥' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtUsd0(n) { return n ? fmtUSD(n) : '—'; }
function fmtCny0(n) { return n ? fmtCNY(n) : '—'; }
// UTC 时间戳 -> 北京时间 YYYY-MM-DD（跟进历史的 recorded_at 是 UTC）。
function beijingDate(iso) {
  if (!iso) return '';
  var t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  return new Date(t.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function monthKey(dateStr) { return String(dateStr || '').slice(0, 7); }
// 询盘首次进入“已成交”的北京时间：跟进历史里 content 含“阶段：已成交”的最早一条；
// 没有这样的历史时，回退到该询盘的创建时间（仅对当前阶段就是已成交的询盘，
// 否则每条询盘都会在自己创建的月份“成交”）。返回 { inquiry_no: 'YYYY-MM-DD' }。
function firstClosedDateByInquiry(history, inquiries) {
  var map = {};
  (history || []).forEach(function (h) {
    if (!h || !h.inquiry_no) return;
    if (String(h.content || '').indexOf('阶段：已成交') === -1) return;
    var d = beijingDate(h.recorded_at);
    if (!d) return;
    if (!map[h.inquiry_no] || d < map[h.inquiry_no]) map[h.inquiry_no] = d;
  });
  (inquiries || []).forEach(function (inq) {
    if (inq.stage !== '已成交') return;
    if (map[inq.inquiry_no]) return;
    var d = beijingDate(inq.source_created_at || inq.created_at);
    if (d) map[inq.inquiry_no] = d;
  });
  return map;
}
// 成交客户去重键：订单按公司名精确匹配到客户档案用档案 id，匹配不上用公司名本身
// （如 Abdullah：档案里公司为空、姓名是 Abdullah，按口径算自己的一个 key）；
// 询盘用档案 id（无档案时用 profile_no / 询盘 id）。两边同一客户是同一个 key。
function customerKeyForOrder(o, customersByCompany) {
  var c = customersByCompany[String(o.customer_company || '').trim()];
  if (c) return 'id:' + c.id;
  return 'name:' + String(o.customer_company || '').trim();
}
function customerKeyForInquiry(inq) {
  if (inq.customer_id) return 'id:' + inq.customer_id;
  if (inq.profile_no) return 'profile:' + inq.profile_no;
  return 'inq:' + inq.id;
}
// 一个月的经营汇总（全部现算）：
//   销售额集合 = 本月已确认订单 + 本月其它未取消且 profit_status 已核对的订单，每单只计一次；
//   已核对实际利润 = 本月 profit_status 已核对的订单（不限阶段）的 profit_rmb 之和；
//   预计订单利润 = 本月已确认订单中金额/汇率/成本齐全的，Σ(逐单折算 − 成本)；
//   成交客户 = 本月已确认订单的客户 ∪ 本月首次进入已成交的询盘客户，按客户去重；
//   成交率 = 本期询盘中当前阶段已成交的条数 / 本期询盘数（不是成交客户数除以询盘数）。
// 每日明细：询盘按询盘日期；成交客户按日去重；订单数为当日已确认订单；
//   销售额/已核对利润/预计利润按订单日期归属当日。
function computeMonthlySummary(orders, inquiries, history, customers, month) {
  var byCompany = {};
  (customers || []).forEach(function (c) {
    var co = String(c.company || '').trim();
    if (co && !byCompany[co]) byCompany[co] = c;
  });
  var closedByInq = firstClosedDateByInquiry(history, inquiries);
  var inMonth = function (d) { return monthKey(d) === month; };
  var onDay = function (d, ds) { return String(d || '').slice(0, 10) === ds; };

  var monthInquiries = (inquiries || []).filter(function (q) { return inMonth(q.inquiry_date); });
  var monthOrders = (orders || []).filter(function (o) { return inMonth(o.order_date); });
  var confirmed = monthOrders.filter(isConfirmedOrder);

  var salesSet = [], seenSales = {};
  confirmed.forEach(function (o) { if (!seenSales[o.id]) { seenSales[o.id] = true; salesSet.push(o); } });
  monthOrders.forEach(function (o) {
    if (!isCancelledOrder(o) && o.profit_status === '已核对' && !seenSales[o.id]) {
      seenSales[o.id] = true; salesSet.push(o);
    }
  });
  var salesUsd = 0, salesCny = 0, missingSales = 0;
  salesSet.forEach(function (o) {
    var amt = toNum(o.amount_usd), cny = orderCny(o);
    if (amt === null || cny === null) { missingSales++; return; }
    salesUsd = round2(salesUsd + amt);
    salesCny = round2(salesCny + cny);
  });

  var verified = monthOrders.filter(function (o) { return o.profit_status === '已核对'; });
  var verifiedProfit = 0;
  verified.forEach(function (o) { var p = toNum(o.profit_rmb); if (p !== null) verifiedProfit = round2(verifiedProfit + p); });

  // 预计订单利润只算成本真正录入的已确认订单：profit_status 待确认的订单
  // cost_rmb 是 0.00 占位（CSV 里 cost_note 都是“5项待确认”），不是真的 0 成本；
  // 把占位 0 当成真成本会把整单销售额都算成利润（23 条已确认订单都是这种情况）。
  var estOrders = confirmed.filter(function (o) {
    return o.profit_status !== '待确认' &&
      toNum(o.amount_usd) !== null && toNum(o.exchange_rate) !== null && toNum(o.cost_rmb) !== null;
  });
  var estProfit = 0;
  estOrders.forEach(function (o) { estProfit = round2(estProfit + (orderCny(o) - toNum(o.cost_rmb))); });

  var convertedKeys = {};
  confirmed.forEach(function (o) { convertedKeys[customerKeyForOrder(o, byCompany)] = true; });
  (inquiries || []).forEach(function (q) {
    var d = closedByInq[q.inquiry_no];
    if (d && inMonth(d)) convertedKeys[customerKeyForInquiry(q)] = true;
  });

  var convNow = monthInquiries.filter(function (q) { return q.stage === '已成交'; }).length;

  var y = parseInt(month.slice(0, 4), 10), mo = parseInt(month.slice(5, 7), 10);
  var daysInMonth = new Date(y, mo, 0).getDate();
  var daily = [];
  for (var day = 1; day <= daysInMonth; day++) {
    var ds = month + '-' + String(day).padStart(2, '0');
    var dInq = monthInquiries.filter(function (q) { return onDay(q.inquiry_date, ds); });
    var dConf = confirmed.filter(function (o) { return onDay(o.order_date, ds); });
    var dSalesSet = salesSet.filter(function (o) { return onDay(o.order_date, ds); });
    var dUsd = 0, dCny = 0;
    dSalesSet.forEach(function (o) {
      var amt = toNum(o.amount_usd), cny = orderCny(o);
      if (amt === null || cny === null) return;
      dUsd = round2(dUsd + amt); dCny = round2(dCny + cny);
    });
    var dVerProfit = 0;
    monthOrders.forEach(function (o) {
      if (o.profit_status !== '已核对' || !onDay(o.order_date, ds)) return;
      var p = toNum(o.profit_rmb);
      if (p !== null) dVerProfit = round2(dVerProfit + p);
    });
    var dEst = 0;
    dConf.forEach(function (o) {
      // 同上：待确认的 0.00 成本是占位，不可算
      if (o.profit_status === '待确认') return;
      if (toNum(o.amount_usd) === null || toNum(o.exchange_rate) === null || toNum(o.cost_rmb) === null) return;
      dEst = round2(dEst + (orderCny(o) - toNum(o.cost_rmb)));
    });
    var dKeys = {};
    dConf.forEach(function (o) { dKeys[customerKeyForOrder(o, byCompany)] = true; });
    (inquiries || []).forEach(function (q) {
      if (closedByInq[q.inquiry_no] === ds) dKeys[customerKeyForInquiry(q)] = true;
    });
    daily.push({
      date: ds, inquiries: dInq.length, converted: Object.keys(dKeys).length,
      orders: dConf.length, salesUsd: dUsd, salesCny: dCny,
      verifiedProfit: dVerProfit, estimatedProfit: dEst,
      hasOrders: monthOrders.some(function (o) { return onDay(o.order_date, ds); })
    });
  }

  return {
    month: month,
    inquiries: monthInquiries.length,
    convertedCustomers: Object.keys(convertedKeys).length,
    confirmedOrders: confirmed.length,
    salesUsd: salesUsd, salesCny: salesCny, missingSales: missingSales,
    verifiedProfit: verifiedProfit, verifiedA: verified.length, verifiedB: salesSet.length,
    estimatedProfit: estProfit, estA: estOrders.length, estB: confirmed.length,
    conversionRate: monthInquiries.length ? (100 * convNow / monthInquiries.length) : 0,
    conversionNum: convNow, conversionDen: monthInquiries.length,
    daily: daily
  };
}

// ---------- Supabase REST（fetch 直调，10 秒超时；与工作面板同一做法） ----------
function sb(table, opts) {
  opts = opts || {};
  var method = opts.method || 'GET';
  var url = SUPABASE_URL + '/rest/v1/' + table;
  if (opts.query) url += '?' + opts.query;
  if (opts.id) url += '?id=eq.' + encodeURIComponent(opts.id);
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  return fetch(url, {
    method: method,
    signal: ctrl.signal,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (txt) { throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 200)); });
    return res.text().then(function (text) { return text ? JSON.parse(text) : null; });
  }).catch(function (e) {
    if (e.name === 'AbortError') throw new Error('请求超时（10 秒），请检查网络后重试');
    throw e;
  }).finally(function () { clearTimeout(timer); });
}
var sbList = function (t, order) { return sb(t, { query: 'select=*&order=' + (order || 'created_at.desc') }); };
var sbInsert = function (t, row) { return sb(t, { method: 'POST', body: row }); };
var sbUpdate = function (t, id, patch) { return sb(t, { method: 'PATCH', id: id, body: patch }); };
var sbDelete = function (t, id) { return sb(t, { method: 'DELETE', id: id }); };
// 按条件批量 PATCH（Supabase REST：PATCH /rest/v1/<表>?<条件>），用于回信自动停：
// 把某条询盘下未完成的待办一次置 done=true。返回被改的行（数组）。
function sbUpdateWhere(t, query, patch) {
  var url = SUPABASE_URL + '/rest/v1/' + t + '?' + query;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  return fetch(url, {
    method: 'PATCH',
    signal: ctrl.signal,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(patch)
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (txt) { throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 200)); });
    return res.text().then(function (text) { return text ? JSON.parse(text) : []; });
  }).finally(function () { clearTimeout(timer); });
}
// v3：写跟进时默认建待办（到期日默认 +DEFAULT_TODO_DAYS 天）。
// 指纹去重：同一询盘 + 同一下一步 + 同一到期日不重复建；冲突时静默跳过，不报错。
function createFollowupTodo(inquiry, nextAction, dueDate) {
  if (!hasKey || !inquiry || !inquiry.id) return Promise.resolve(null);
  var due = dueDate || addDays(todayStr(), DEFAULT_TODO_DAYS);
  var action = nextAction || inquiry.next_action || '先看客户最新回复，再决定下一步';
  var fingerprint = inquiry.id + '|' + action + '|' + due;
  return sbInsert('followup_todos', {
    customer_id: inquiry.customer_id || null,
    inquiry_id: inquiry.id,
    reason: '跟进已写：' + action,
    next_action: action,
    due_at: due,
    done: false,
    stopped_by_reply: false,
    fingerprint: fingerprint
  }).catch(function () { return null; }); // 指纹冲突（已建过）时静默跳过
}
// v3：回信自动停。客户一回信（人工确认或同步匹配），把该询盘下未完成的自动待办
// 一次置 done=true + stopped_by_reply=true，并返回停掉的条数；同时写一条跟进历史留痕。
// 注意：只停待办，不改 reply_status 为“已处理”——回复仍是“已回复 · 待判断”，必须人工看。
function autoStopTodosForInquiry(inquiryId, customerId) {
  if (!hasKey || !inquiryId) return Promise.resolve(0);
  return sbUpdateWhere('followup_todos',
    'inquiry_id=eq.' + encodeURIComponent(inquiryId) + '&done=eq.false',
    { done: true, stopped_by_reply: true }
  ).then(function (stopped) {
    var n = Array.isArray(stopped) ? stopped.length : 0;
    if (n > 0) {
      sbInsert('followup_history', {
        customer_id: customerId || null, inquiry_id: inquiryId,
        profile_no: '', inquiry_no: '', record_no: 'auto-stop-' + inquiryId + '-' + Date.now(),
        record_type: '回信自动停', content: '客户已回复，自动停止未完成的跟进待办 ' + n + ' 条；回复仍为“已回复 · 待判断”，待人工确认。',
        recorded_at: new Date().toISOString()
      }).catch(function () { /* 历史写失败不影响主流程 */ });
    }
    return n;
  }).catch(function () { return 0; });
}
// v3：开发 / 阅读计数。outreach_count：发出一封跟进邮件 +1；read_count：收到并匹配到一封回复 +1。
function bumpCounter(customerId, field) {
  if (!hasKey || !customerId || (field !== 'outreach_count' && field !== 'read_count')) return Promise.resolve();
  var cust = customerById(customerId);
  var cur = cust ? (parseInt(cust[field], 10) || 0) : 0;
  var patch = {};
  patch[field] = cur + 1;
  patch.updated_at = new Date().toISOString();
  return sbUpdate('followup_customers', customerId, patch).then(function (updated) {
    if (updated && updated[0] && cust) Object.assign(cust, updated[0]);
    else if (cust) cust[field] = cur + 1;
  }).catch(function () { /* 计数写失败不影响主流程 */ });
}

// ---------- DOM 工具（只在浏览器里用） ----------
function $(id) { return document.getElementById(id); }
function setStatus(msg, isError) {
  var el = $('status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}
function customerById(id) {
  for (var i = 0; i < state.customers.length; i++) if (String(state.customers[i].id) === String(id)) return state.customers[i];
  return null;
}
function inquiryById(id) {
  for (var i = 0; i < state.inquiries.length; i++) if (String(state.inquiries[i].id) === String(id)) return state.inquiries[i];
  return null;
}

// ---------- 渲染 ----------
function renderDate() {
  var now = new Date();
  var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  $('today').textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + week;
}

function renderCards() {
  var cards = computeCards(state.customers, state.inquiries, state.emails);
  $('cardDue').textContent = cards.due;
  $('cardOverdue').textContent = cards.overdue;
  $('cardReview').textContent = cards.review;
  $('cardWaiting').textContent = cards.waiting;
  $('customerCount').textContent = state.customers.length || '';
  $('reviewCount').textContent = cards.review || '';
  $('allCount').textContent = state.inquiries.length || '';
  $('orderCount').textContent = state.orders.length || '';
  $('supplierCount').textContent = state.suppliers.length || '';
  var pc = $('prospectCount');
  if (pc) pc.textContent = state.prospects.length || '';
}

function replyBadge(inq) {
  if (inq.reply_status === '已回复 · 待判断') return ' <span class="badge review">待判断</span>';
  if (inq.reply_status === '未回复 · 等待客户') return ' <span class="badge waiting">等待客户</span>';
  if (inq.reply_status === '已回复 · 已处理') return ' <span class="badge done">已处理</span>';
  return '';
}

function filteredInquiries() {
  var t = todayStr();
  var rows = state.inquiries.map(function (inq) {
    return { inq: inq, cust: customerById(inq.customer_id), key: computeInquiryStatus(inq, customerById(inq.customer_id), t) };
  }).filter(function (r) {
    if (isTerminalStage(r.inq.stage)) return false;
    return r.key !== 'done' && r.key !== 'lost' && r.key !== 'archived';
  });
  if (currentFilter === 'waiting') {
    rows = rows.filter(function (r) { return r.inq.reply_status === '未回复 · 等待客户'; });
  } else if (currentFilter !== 'all') {
    rows = rows.filter(function (r) { return r.key === currentFilter; });
  }
  if (searchText) {
    var q = searchText.toLowerCase();
    rows = rows.filter(function (r) {
      return ((r.cust && (r.cust.name || '') + ' ' + (r.cust.company || '') + ' ' + (r.cust.email || '')) + ' ' + (r.inq.product || '') + ' ' + (r.inq.product_category || '')).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) {
    var da = a.inq.next_followup_at || '9999', db = b.inq.next_followup_at || '9999';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return rows;
}

// 一条询盘的 4 列表格行（客户/询盘需求 | 阶段与回复 | 下一步动作 | 下次跟进）。
// 跟进清单与全部询盘共用：行内编辑（编辑跟进 / 保存 / 取消）两边都能用。
function inquiryRowHtml(r) {
  var inq = r.inq, cust = r.cust || {};
  var lastEmail = null;
  state.emails.forEach(function (e) { if (String(e.inquiry_id) === String(inq.id)) lastEmail = e; });
  var html = '<tr><td><div class="c-name">' + esc(cust.company || cust.name || '未知客户') + '</div>' +
    '<div class="c-sub">' + esc(cust.name || '') + (cust.email ? ' · ' + esc(cust.email) : '') + '</div>' +
    '<div class="c-sub">' + esc(inq.product || '') + (inq.product_category ? ' · ' + esc(inq.product_category) : '') + (inq.quantity ? ' · ' + esc(inq.quantity) : '') + '</div>' +
    '<div class="row-actions"><button class="small ghost" data-edit-inquiry="' + esc(inq.id) + '">编辑跟进</button></div></td>' +
    '<td><span class="badge ' + (STATUS_BADGE[r.key] || 'pending') + '">' + esc(STATUS_LABELS[r.key] || r.key) + '</span>' + replyBadge(inq) +
    (inq.stage ? '<div class="c-sub" style="margin-top:6px">阶段：' + esc(inq.stage) + '</div>' : '') +
    (lastEmail ? '<div class="c-sub">最新回复：' + esc(lastEmail.subject || '') + '（' + esc(INTENT_LABELS[lastEmail.intent] || lastEmail.intent) + '）</div>' : '') +
    (inq.reply_snippet ? '<div class="c-sub">最近回复：' + esc(inq.reply_snippet) + '</div>' : '') +
    '</td>' +
    '<td>' + esc(inq.next_action || cust.next_action || '—') + '</td>' +
    '<td>' + esc(fmtDate(inq.next_followup_at)) + '</td></tr>';
  if (editingId === String(inq.id)) {
    html += '<tr class="edit-row"><td colspan="4">' +
      '<label class="muted">当前阶段</label><select id="editStage">' +
      STAGES.map(function (s) {
        return '<option value="' + esc(s) + '"' + (s === inq.stage ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('') + '</select>' +
      '<label class="muted">下一步动作</label><input type="text" id="editAction" value="' + esc(inq.next_action || '') + '" placeholder="例如：跟进客户是否提供收货地址">' +
      '<label class="muted">下次跟进日期</label><input type="date" id="editNext" value="' + esc(fmtDate(inq.next_followup_at) === '—' ? '' : fmtDate(inq.next_followup_at)) + '">' +
      // v3：写跟进默认同时建待办（默认勾选，到期日 = 下次跟进日期，未填则今天 +3 天）
      '<label class="todo-check"><input type="checkbox" id="editCreateTodo" checked> 同时创建待办（到期 ' + esc(fmtDate(inq.next_followup_at) === '—' ? addDays(todayStr(), DEFAULT_TODO_DAYS) : fmtDate(inq.next_followup_at)) + '）</label>' +
      '<div class="row-actions"><button class="small" data-save-inquiry="' + esc(inq.id) + '">保存</button>' +
      '<button class="small ghost" data-reply-inquiry="' + esc(inq.id) + '">回复客户</button>' +
      '<button class="small ghost" data-cancel-edit="1">取消</button></div>' +
      (replyingTo && String(replyingTo.inquiryId) === String(inq.id) && !replyingTo.emailId ? replyBoxHtml(inq, null) : '') +
      '</td></tr>';
  }
  return html;
}

function renderFollowList() {
  var el = $('followList');
  var rows = filteredInquiries();
  $('listCount').textContent = '（' + rows.length + ' 条）';
  if (!rows.length) {
    el.innerHTML = '<div class="empty">这个筛选下暂无记录。' +
      (state.inquiries.length === 0 ? '请先按 README 第 5 步导入旧站导出文件（216 位客户 / 201 条询盘）。' : '') + '</div>';
    return;
  }
  var html = '<table class="follow-table"><thead><tr><th>客户 / 询盘需求</th><th>阶段与回复</th><th>下一步动作</th><th>下次跟进</th></tr></thead><tbody>';
  rows.forEach(function (r) { html += inquiryRowHtml(r); });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// 全部询盘：不按状态过滤，终态（暂缓/已关闭/已成交）也在内，201 条全列出；
// 直接读已加载的同一批询盘，不新增 Supabase 查询，与跟进清单用同一张 4 列表格。
function allInquiries() {
  var t = todayStr();
  var rows = state.inquiries.map(function (inq) {
    return { inq: inq, cust: customerById(inq.customer_id), key: computeInquiryStatus(inq, customerById(inq.customer_id), t) };
  });
  if (allSearchText) {
    var q = allSearchText.toLowerCase();
    rows = rows.filter(function (r) {
      return ((r.cust && (r.cust.name || '') + ' ' + (r.cust.company || '') + ' ' + (r.cust.email || '')) + ' ' + (r.inq.product || '') + ' ' + (r.inq.product_category || '')).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) {
    var da = a.inq.next_followup_at || '9999', db = b.inq.next_followup_at || '9999';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return rows;
}

function renderAllInquiries() {
  var el = $('allList');
  var rows = allInquiries();
  $('allListCount').textContent = '（' + rows.length + ' 条）';
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无询盘记录。' +
      (state.inquiries.length === 0 ? '请先按 README 第 5 步导入旧站导出文件（216 位客户 / 201 条询盘）。' : '') + '</div>';
    return;
  }
  var html = '<table class="follow-table"><thead><tr><th>客户 / 询盘需求</th><th>阶段与回复</th><th>下一步动作</th><th>下次跟进</th></tr></thead><tbody>';
  rows.forEach(function (r) { html += inquiryRowHtml(r); });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderTodos() {
  var el = $('todoList');
  var todos = buildTodos(state.customers, state.inquiries);
  if (!todos.length) { el.innerHTML = '<div class="empty">今天没有需要特别处理的待办。</div>'; return; }
  el.innerHTML = '<ol class="todo-list">' + todos.map(function (td) {
    return '<li><b>' + esc(td.customer) + '</b> — ' + esc(td.product) +
      '<div class="why">为什么：' + esc(td.reason) + '；下一步：' + esc(td.next_action) +
      '；下次跟进：' + esc(td.due) + '</div></li>';
  }).join('') + '</ol>';
}

// ---------- 客户档案页（旧系统样式：宽松 6 列 + 头像 + 等级徽章） ----------
// 旧站 6 列：公司/联系人 | 重要等级/建议 | 国家与类型 | 联系方式 | 最后联系 | 关联询盘。
// 空字段只显示旧站的“待补充”占位，不编造内容。
var AVATAR_COLORS = [
  { bg: '#e8f5e9', fg: '#2e7d32' }, { bg: '#f3e8fd', fg: '#7e57c2' },
  { bg: '#e3f2fd', fg: '#1565c0' }, { bg: '#fff3e0', fg: '#e65100' },
  { bg: '#fce4ec', fg: '#c2185b' }, { bg: '#e0f2f1', fg: '#00695c' },
  { bg: '#fff8e1', fg: '#f57f17' }, { bg: '#ede7f6', fg: '#512da8' }
];
function avatarColor(name) {
  var h = 0;
  for (var i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function gradePillClass(grade) {
  var g = String(grade || '');
  if (g.charAt(0) === 'A') return 'grade-a';
  if (g.charAt(0) === 'B') return 'grade-b';
  if (g.charAt(0) === 'C') return 'grade-c';
  return 'grade-pending';
}
function whatsappUrl(w) {
  var s = String(w || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  var digits = s.replace(/\D/g, '');
  return digits ? 'https://wa.me/' + digits : '';
}
// 每个客户的询盘数 + 进行中数（进行中 = 阶段不在 暂缓/已关闭/已成交）。
function customerInquiryStats() {
  var map = {};
  state.inquiries.forEach(function (inq) {
    var k = String(inq.customer_id || '');
    if (!k) return;
    var s = map[k] || (map[k] = { total: 0, active: 0 });
    s.total++;
    if (!isTerminalStage(inq.stage)) s.active++;
  });
  return map;
}
// 搜索 + 类型 + 等级三者叠加筛选（搜索只看公司、联系人、邮箱、国家）。
function filteredCustomers() {
  var rows = state.customers.slice();
  if (customerTypeFilter === '__missing__') {
    rows = rows.filter(function (c) { return !String(c.customer_type || '').trim(); });
  } else if (customerTypeFilter) {
    rows = rows.filter(function (c) { return String(c.customer_type || '') === customerTypeFilter; });
  }
  if (customerGradeFilter) {
    rows = rows.filter(function (c) { return String(c.grade || '') === customerGradeFilter; });
  }
  if (customerSearchText) {
    var q = customerSearchText.toLowerCase();
    rows = rows.filter(function (c) {
      return ((c.company || '') + ' ' + (c.name || '') + ' ' + (c.email || '') + ' ' + (c.country || '')).toLowerCase().indexOf(q) !== -1;
    });
  }
  return rows;
}
// 类型/等级下拉选项由数据里实际出现的值生成；数据不变时不重建（不丢当前选择）。
function syncCustomerFilterOptions() {
  var typeSel = $('filterCustomerType'), gradeSel = $('filterCustomerGrade');
  if (!typeSel || !gradeSel) return;
  var types = [], seenT = {};
  state.customers.forEach(function (c) {
    var t = String(c.customer_type || '').trim();
    if (t && !seenT[t]) { seenT[t] = true; types.push(t); }
  });
  types.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
  var gradeOrder = ['A · 重点跟进', 'B · 正常推进', 'C · 暂缓 / 低优先', '待评估'];
  var grades = [], seenG = {};
  state.customers.forEach(function (c) {
    var g = String(c.grade || '');
    if (g && !seenG[g]) { seenG[g] = true; grades.push(g); }
  });
  grades.sort(function (a, b) {
    var ia = gradeOrder.indexOf(a), ib = gradeOrder.indexOf(b);
    if (ia === -1) ia = 99; if (ib === -1) ib = 99;
    return (ia - ib) || a.localeCompare(b, 'zh-CN');
  });
  var sig = types.join('|') + '#' + grades.join('|');
  if (sig === customerFilterSig) return;
  customerFilterSig = sig;
  var curT = typeSel.value, curG = gradeSel.value;
  typeSel.innerHTML = '<option value="">全部客户类型</option>' +
    types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') +
    '<option value="__missing__">类型待补充</option>';
  gradeSel.innerHTML = '<option value="">全部重要等级</option>' +
    grades.map(function (g) { return '<option value="' + esc(g) + '">' + esc(g) + '</option>'; }).join('');
  if (curT && (curT === '__missing__' || seenT[curT])) typeSel.value = curT;
  if (curG && seenG[curG]) gradeSel.value = curG;
}

function customerRowHtml(c, st) {
  var t = todayStr();
  var displayName = c.company || c.name || '未知客户';
  var letter = String(displayName).charAt(0) || '?';
  var av = avatarColor(displayName);
  // 公司为空时不重复显示联系人姓名
  var contactLine = (c.company && c.name) ? esc(c.name) : '';
  if (c.job_title) contactLine += (contactLine ? ' · ' : '') + esc(c.job_title);
  var last = c.last_contact_at ? String(c.last_contact_at).slice(0, 10) : '';
  var gap = last ? daysBetween(last, t) : null;
  var wa = whatsappUrl(c.whatsapp);
  var checked = selectedCustomerIds[String(c.id)] ? ' checked' : '';
  return '<tr>' +
    '<td class="check-col"><input type="checkbox" data-select-customer="' + esc(c.id) + '"' + checked + '></td>' +
    '<td><div class="cust-id"><span class="cust-avatar" style="background:' + av.bg + ';color:' + av.fg + '">' + esc(letter) + '</span><div class="cust-id-text">' +
    '<div class="cust-company">' + esc(displayName) + '</div>' +
    (contactLine ? '<div class="cust-sub">' + contactLine + '</div>' : '') +
    (c.cn_background_status === '已完成' ? '<div class="cust-bg">中文背调已完成</div>' : '') +
    (c.website ? '<div class="cust-sub">' + esc(c.website) + '</div>' : '') +
    '</div></div></td>' +
    '<td><span class="grade-pill ' + gradePillClass(c.grade) + '">' + esc(c.grade || '待评估') + '</span>' +
    (c.eval_advice ? '<div class="cust-advice">' + esc(c.eval_advice) + '</div>' : '') + '</td>' +
    '<td>' + (c.country ? '<div>' + esc(c.country) + '</div>' : '<div class="cust-sub">地区待补充</div>') +
    (c.customer_type ? '<span class="type-pill">' + esc(c.customer_type) + '</span>' : '<span class="type-pill type-missing">类型待补充</span>') + '</td>' +
    '<td>' + (c.email ? '<div>' + esc(c.email) + '</div>' : '<div class="cust-sub">—</div>') +
    (c.phone ? '<div class="cust-sub">手机 ' + esc(c.phone) + '</div>' : '') +
    (wa ? '<a class="wa-btn" href="' + esc(wa) + '" target="_blank" rel="noopener">打开 WhatsApp ↗</a>' : '') + '</td>' +
    '<td>' + (gap === null ? '—' : '<div>' + gap + ' 天未联系</div><div class="cust-sub">' + esc(last) + '</div>') + '</td>' +
    '<td><div><b class="inq-num">' + st.total + '</b> 条询盘</div><div class="cust-sub">' + st.active + ' 条进行中</div></td>' +
    '<td class="chev">›</td></tr>';
}

function renderCustomers() {
  var el = $('customerList');
  syncCustomerFilterOptions();
  var pill = $('customerCountPill');
  if (pill) pill.textContent = state.customers.length;
  var rows = filteredCustomers();
  var stats = customerInquiryStats();
  var selectedCount = Object.keys(selectedCustomerIds).filter(function (id) { return selectedCustomerIds[id]; }).length;
  var batchBtn = $('batchDeleteBtn');
  if (batchBtn) {
    batchBtn.disabled = selectedCount === 0;
    batchBtn.textContent = selectedCount > 0 ? '🗑 批量删除（' + selectedCount + '）' : '🗑 批量删除';
  }
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无客户档案。' +
      (state.customers.length === 0 ? '请先按 README 第 5 步导入旧站导出文件（216 位客户）。' : '试试换个搜索词或筛选条件。') + '</div>';
    return;
  }
  var allSelected = rows.length > 0 && rows.every(function (c) { return selectedCustomerIds[String(c.id)]; });
  var html = '<table class="cust-table"><thead><tr>' +
    '<th class="check-col"><input type="checkbox" data-select-all-customers' + (allSelected ? ' checked' : '') + ' title="全选当前筛选结果"></th>' +
    '<th>公司 / 联系人</th><th>重要等级 / 建议</th><th>国家与类型</th><th>联系方式</th><th>最后联系</th><th>关联询盘</th><th></th>' +
    '</tr></thead><tbody>';
  rows.forEach(function (c) { html += customerRowHtml(c, stats[String(c.id)] || { total: 0, active: 0 }); });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// 客户档案页的状态行（导入/导出/删除的反馈，写在表格上方，不动顶部的全局状态行）。
function setCustomerStatus(msg, isError) {
  var el = $('customerStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

// ---------- 客户档案：批量删除 ----------
// 外键实情（supabase-followup.sql）：删客户会级联删掉该客户的询盘、跟进历史、
// 背调/来源/社媒、待办；已同步的邮件是 on delete set null——邮件保留，只取消关联。
// 确认框与提示文案都按这个实情写，不写“邮件一起删除”。
function batchDeleteCustomers() {
  var ids = Object.keys(selectedCustomerIds).filter(function (id) { return selectedCustomerIds[id]; });
  if (!ids.length) return;
  var inqCount = state.inquiries.filter(function (inq) { return selectedCustomerIds[String(inq.customer_id)]; }).length;
  var ok = confirm('确定删除选中的 ' + ids.length + ' 位客户吗？\n\n将同时删除：\n· 该客户的 ' + inqCount + ' 条询盘\n· 相关的跟进记录和待办\n\n已同步的邮件会保留，但不再关联这些客户。\n\n删除后无法恢复，请谨慎操作。');
  if (!ok) return;
  if (!hasKey) { alert('未配置 Supabase key，无法删除'); return; }
  setCustomerStatus('正在删除 ' + ids.length + ' 位客户……');
  var done = 0, failed = 0;
  var chain = Promise.resolve();
  ids.forEach(function (id) {
    chain = chain.then(function () {
      return sbDelete('followup_customers', id).then(function () { done++; }).catch(function () { failed++; });
    });
  });
  chain.then(function () {
    selectedCustomerIds = {};
    loadAll();
    setCustomerStatus('已删除 ' + done + ' 位客户' + (failed ? '，失败 ' + failed + ' 位（请刷新后重试）' : '') + '。');
  });
}

// ---------- 客户档案：导入 / 导出 Excel ----------
// SheetJS 只在第一次点导入/导出时才懒加载；文件就放在本站同目录（xlsx.full.min.js，
// SheetJS 0.18.5），不走 CDN——2026-11-16 实测 CDN 加载在浏览器里超过 60 秒没反应，
// 改成本地文件后导入/导出不再依赖外网。页面本身平时不加载它。导入 .csv 不需要 SheetJS，始终可用。
var sheetJsPromise = null;
function loadSheetJS() {
  if (typeof window !== 'undefined' && window.XLSX) return Promise.resolve(window.XLSX);
  if (sheetJsPromise) return sheetJsPromise;
  sheetJsPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'xlsx.full.min.js';
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('加载超时（20 秒）')); } }, 20000);
    s.onload = function () {
      if (done) return; done = true; clearTimeout(timer);
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error('加载后未找到 XLSX'));
    };
    s.onerror = function () { if (done) return; done = true; clearTimeout(timer); reject(new Error('CDN 加载失败')); };
    document.head.appendChild(s);
  }).catch(function (e) { sheetJsPromise = null; throw e; });
}
// 原生 CSV 解析（处理引号、逗号、换行与 "" 转义），第一行为表头。
function parseCsvText(text) {
  var rows = [];
  var cur = [], field = '', inQ = false;
  var t = String(text || '').replace(/^\uFEFF/, '');
  for (var i = 0; i < t.length; i++) {
    var ch = t[i];
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      cur.push(field); field = '';
      rows.push(cur); cur = [];
    } else field += ch;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  while (rows.length && rows[rows.length - 1].every(function (v) { return String(v).trim() === ''; })) rows.pop();
  if (!rows.length) return [];
  var headers = rows[0].map(function (h) { return String(h || '').trim(); });
  return rows.slice(1).map(function (r) {
    var o = {};
    headers.forEach(function (h, idx) { o[h] = r[idx] != null ? String(r[idx]).trim() : ''; });
    return o;
  });
}
// 导入表头映射：中文为主，英文为 fallback（键一律小写后查）。
var IMPORT_FIELD_MAP = {
  '公司': 'company', 'company': 'company',
  '联系人': 'name', '联系人姓名': 'name', 'contact': 'name',
  '邮箱': 'email', 'email': 'email',
  '国家': 'country', '国家 / 地区': 'country', 'country': 'country',
  '电话': 'phone', '手机号码': 'phone', 'phone': 'phone',
  'whatsapp': 'whatsapp',
  '客户类型': 'customer_type', 'type': 'customer_type',
  '官网': 'website', 'website': 'website',
  '职位': 'job_title', '客户职位': 'job_title', 'title': 'job_title'
};
function normalizeImportRows(rawRows) {
  return (rawRows || []).map(function (r) {
    var o = {};
    Object.keys(r || {}).forEach(function (k) {
      var f = IMPORT_FIELD_MAP[String(k).trim().toLowerCase()];
      if (f && r[k] != null) o[f] = String(r[k]).trim();
    });
    return o;
  });
}
function importCustomersFromRows(rawRows) {
  var rows = normalizeImportRows(rawRows);
  var existing = {};
  state.customers.forEach(function (c) { var e = normalizeEmail(c.email); if (e) existing[e] = true; });
  var seenInFile = {};
  var toInsert = [], skippedDup = 0, skippedNoEmail = 0;
  rows.forEach(function (r) {
    var em = normalizeEmail(r.email);
    if (!em) { skippedNoEmail++; return; }
    if (existing[em] || seenInFile[em]) { skippedDup++; return; }
    seenInFile[em] = true;
    toInsert.push({
      name: r.name || '', company: r.company || '', email: em,
      country: r.country || '', phone: r.phone || '', whatsapp: r.whatsapp || '',
      customer_type: r.customer_type || '', website: r.website || '', job_title: r.job_title || '',
      grade: '待评估', stage: '待评估', source: '导入',
      verification_status: 'unverified', tags: [], outreach_count: 0, read_count: 0,
      health_score: 50, last_contact_at: null, next_followup_at: null, next_action: ''
    });
  });
  if (!toInsert.length) {
    setCustomerStatus('导入完成：新增 0 位，跳过（已存在）' + skippedDup + ' 位，跳过（无邮箱）' + skippedNoEmail + ' 位。');
    return;
  }
  if (!hasKey) { alert('未配置 Supabase key，无法导入'); return; }
  setCustomerStatus('正在导入 ' + toInsert.length + ' 位新客户……');
  // 先整批插一次（快）；整批失败再逐条插，逐条失败的计入失败数。
  var failed = 0;
  sb('followup_customers', { method: 'POST', body: toInsert }).then(function (inserted) {
    var n = Array.isArray(inserted) ? inserted.length : toInsert.length;
    finishImport(n, skippedDup, skippedNoEmail, failed);
  }).catch(function () {
    var chain = Promise.resolve();
    var okCount = 0;
    toInsert.forEach(function (row) {
      chain = chain.then(function () {
        return sbInsert('followup_customers', row).then(function () { okCount++; }).catch(function () { failed++; });
      });
    });
    chain.then(function () { finishImport(okCount, skippedDup, skippedNoEmail, failed); });
  });
}
function finishImport(added, skippedDup, skippedNoEmail, failed) {
  var msg = '导入完成：新增 ' + added + ' 位，跳过（已存在）' + skippedDup + ' 位，跳过（无邮箱）' + skippedNoEmail + ' 位' +
    (failed ? '，失败 ' + failed + ' 位（请检查后重试）' : '') + '。';
  setCustomerStatus(msg);
  loadAll();
}
function handleImportFile(file) {
  if (!file) return;
  var name = String(file.name || '').toLowerCase();
  if (name.endsWith('.csv')) {
    setCustomerStatus('正在读取 ' + file.name + '……');
    file.text().then(function (txt) {
      importCustomersFromRows(parseCsvText(txt));
    }).catch(function (e) { setCustomerStatus('读取文件失败：' + e.message, true); });
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    setCustomerStatus('正在加载表格解析组件并读取 ' + file.name + '……');
    loadSheetJS().then(function (XLSX) {
      return file.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(buf, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        importCustomersFromRows(XLSX.utils.sheet_to_json(ws, { defval: '' }));
      });
    }).catch(function (e) {
      setCustomerStatus('导入失败：表格组件未能从 CDN 加载（' + e.message + '），.xlsx 暂不可导入；可以先把文件另存为 .csv 再导入。', true);
    });
  } else {
    setCustomerStatus('只支持 .xlsx / .csv 文件。', true);
  }
  $('importCustomersFile').value = ''; // 允许下次再选同一个文件
}
// 导出全部客户（忽略当前搜索/筛选）的成对行：每条询盘一行 + 无询盘的客户补一行。
function allCustomerExportPairs() {
  var byId = {};
  state.customers.forEach(function (c) { byId[c.id] = c; });
  var out = state.inquiries.map(function (inq) { return { customer: byId[inq.customer_id] || {}, inquiry: inq }; });
  var withInquiry = {};
  state.inquiries.forEach(function (inq) { withInquiry[inq.customer_id] = true; });
  state.customers.forEach(function (c) { if (!withInquiry[c.id]) out.push({ customer: c, inquiry: null }); });
  return out;
}
// 导出全部客户 Excel：3 个工作表（客户档案 / 关联询盘 / 邮件沟通），一律是全部数据，
// 不受下方搜索与筛选影响。SheetJS 现在由 index.html 随页面一起加载（xlsx.full.min.js，
// 本地文件），导出时直接同步生成，不再动态注入脚本、不再等定时器——2026-11-16 实测
// 动态加载那一路在浏览器里会一直卡在“正在准备导出……”上（20 秒兜底定时器也不触发）。
// 如果表格组件万一没加载进来，立刻退回下载同名字段的 CSV，并明说。
function exportCustomersExcel() {
  setCustomerStatus('正在准备导出全部客户……');
  if (typeof window !== 'undefined' && window.XLSX) {
    try {
      var XLSX = window.XLSX;
    var byId = {};
    state.customers.forEach(function (c) { byId[c.id] = c; });
    var inqNoById = {};
    state.inquiries.forEach(function (inq) { inqNoById[inq.id] = inq.inquiry_no || ''; });
    var custRows = state.customers.map(function (c) {
      return {
        '客户档案编号': c.profile_no || '', '公司': c.company || '', '联系人': c.name || '',
        '国家': c.country || '', '职位': c.job_title || '', '邮箱': c.email || '',
        '官网': c.website || '', '电话': c.phone || '', 'WhatsApp': c.whatsapp || '',
        '其他联系方式': c.other_contact || '', '客户类型': c.customer_type || '',
        '客户来源': c.source || '', '等级': c.grade || '', '等级设置': c.grade_source || '',
        '跟进建议': c.eval_advice || '', '建议下一步': c.eval_next_action || '',
        '邮箱验证状态': verificationLabel(c.verification_status || 'unverified'),
        '标签': tagsToString(c.tags), '发出计数': c.outreach_count || 0, '已读计数': c.read_count || 0,
        '健康度': c.health_score, '最后联系': fmtDate(c.last_contact_at) === '—' ? '' : fmtDate(c.last_contact_at),
        '下次跟进': fmtDate(c.next_followup_at) === '—' ? '' : fmtDate(c.next_followup_at),
        '下一步动作': c.next_action || '', '中文背调状态': c.cn_background_status || '',
        '客户背景': c.background || '', '客户备注': c.notes || '',
        '创建时间': c.source_created_at || '', '更新时间': c.source_updated_at || ''
      };
    });
    var inqRows = state.inquiries.map(function (inq) {
      var c = byId[inq.customer_id] || {};
      return {
        '询盘编号': inq.inquiry_no || '', '客户档案编号': inq.profile_no || '',
        '公司': c.company || '', '联系人': c.name || '',
        '产品类别': inq.product_category || '', '产品需求': inq.product || '',
        '规格': inq.specs || '', '数量': inq.quantity || '', '当前阶段': inq.stage || '',
        '客户回复状态': inq.reply_status || '', '最近回复': inq.reply_snippet || '',
        '询盘日期': inq.inquiry_date || '',
        '最近联系日期': fmtDate(inq.last_contact_at) === '—' ? '' : fmtDate(inq.last_contact_at),
        '下次跟进日期': fmtDate(inq.next_followup_at) === '—' ? '' : fmtDate(inq.next_followup_at),
        '日期已手动确认': inq.next_followup_confirmed ? '是' : '否',
        '下一步动作': inq.next_action || '', '询盘备注': inq.notes || ''
      };
    });
    var mailRows = state.emails.map(function (e) {
      var c = byId[e.customer_id] || {};
      return {
        '客户': c.company || c.name || '', '询盘编号': inqNoById[e.inquiry_id] || '',
        '主题': e.subject || '', '发件人': e.from_email || '', '收件人': e.to_email || '',
        '方向': e.direction === 'out' ? '发出' : '收到',
        '发送时间': e.sent_at || '', '意向': INTENT_LABELS[e.intent] || e.intent || '',
        '待判断': e.needs_review ? '是' : '否', '摘要': e.snippet || ''
      };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(custRows), '客户档案');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inqRows), '关联询盘');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mailRows), '邮件沟通');
    XLSX.writeFile(wb, '客户档案-' + todayStr() + '.xlsx');
    setCustomerStatus('已导出全部 ' + state.customers.length + ' 位客户（客户档案 / 关联询盘 / 邮件沟通 3 个工作表，不受筛选影响）。');
    return;
    } catch (e) {
      // 生成失败也退回 CSV，不卡住
    }
  }
  exportCustomersCsvFallback();
}

function exportCustomersCsvFallback() {
    var csv = buildExportCsv(allCustomerExportPairs());
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '客户档案-' + todayStr() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    setCustomerStatus('表格组件未能加载，已改为导出 CSV（全部 ' + state.customers.length + ' 位客户，字段相同），请检查下载。', true);
}

function renderReview() {
  var el = $('reviewList');
  // 待判断以询盘的 reply_status 为主（导入数据）；邮箱同步新到的未判断邮件为辅
  var reviewInquiries = state.inquiries.filter(function (inq) {
    return inq.reply_status === '已回复 · 待判断' && !isTerminalStage(inq.stage);
  });
  var pendingEmails = state.emails.filter(function (e) { return e.needs_review; });
  if (!reviewInquiries.length && !pendingEmails.length) {
    el.innerHTML = '<div class="empty">没有待判断的回复，全部已处理。</div>';
    return;
  }
  var html = '';
  reviewInquiries.forEach(function (inq) {
    var cust = customerById(inq.customer_id) || {};
    html += '<div class="review-card" data-inquiry="' + esc(inq.id) + '">' +
      '<div class="r-subject">' + esc(cust.company || cust.name || '未知客户') + ' — ' + esc(inq.product || '') + '</div>' +
      '<div class="r-meta">阶段：' + esc(inq.stage || '') + ' · 下次跟进：' + esc(fmtDate(inq.next_followup_at)) + '</div>' +
      '<div>' + esc(inq.reply_snippet || inq.summary || '') + '</div>' +
      '<div class="r-actions"><select data-intent>' +
      Object.keys(INTENT_LABELS).map(function (k) {
        return '<option value="' + k + '">' + INTENT_LABELS[k] + '</option>';
      }).join('') + '</select>' +
      '<button class="small" data-confirm-inquiry-review="' + esc(inq.id) + '">确认并标记已处理</button>' +
      '<button class="small ghost" data-reply-inquiry="' + esc(inq.id) + '">回复客户</button></div>' +
      (replyingTo && String(replyingTo.inquiryId) === String(inq.id) && !replyingTo.emailId ? replyBoxHtml(inq, null) : '') +
      '</div>';
  });
  pendingEmails.forEach(function (e) {
    var cust = customerById(e.customer_id) || {};
    html += '<div class="review-card" data-email="' + esc(e.id) + '">' +
      '<div class="r-subject">' + esc(e.subject || '（无主题）') + '</div>' +
      '<div class="r-meta">' + esc(e.from_email || '') + ' → kevin@neoprenecustom.com · ' +
      esc(fmtDate(e.sent_at)) + ' · 客户：' + esc(cust.company || cust.name || '未知') + '（邮箱同步新到）</div>' +
      '<div>' + esc(e.snippet || '') + '</div>' +
      '<div class="r-body hidden" data-body>' + esc(e.body_text || '') + '</div>' +
      '<div class="r-actions"><select data-intent>' +
      Object.keys(INTENT_LABELS).map(function (k) {
        return '<option value="' + k + '"' + (k === e.intent ? ' selected' : '') + '>' + INTENT_LABELS[k] + '</option>';
      }).join('') + '</select>' +
      '<button class="small" data-confirm-review="' + esc(e.id) + '">确认并标记已处理</button>' +
      '<button class="small ghost" data-toggle-body>查看原文</button>' +
      '<button class="small ghost" data-reply-email="' + esc(e.id) + '">回复这封邮件</button></div>' +
      (replyingTo && String(replyingTo.emailId) === String(e.id) && inquiryById(e.inquiry_id) ? replyBoxHtml(inquiryById(e.inquiry_id), e) : '') +
      '</div>';
  });
  el.innerHTML = html;
}

// ---------- 项目与订单（旧系统样式：宽松 6 列表格） ----------
// 订单类型 = 阶段在“·”之前的部分（“订单确认·返单”属“订单确认”，“采购/生产·已发货”属“采购/生产”）。
function orderTypeOf(stage) { return String(stage || '').split('·')[0]; }
// 每个公司的累计已确认订单数（与经营汇总同一口径，从已加载的全部订单里算，不受筛选影响）。
function confirmedCountByCompany() {
  var map = {};
  state.orders.forEach(function (o) {
    var co = String(o.customer_company || '').trim();
    if (!co) return;
    if (!map[co]) map[co] = 0;
    if (isConfirmedOrder(o)) map[co]++;
  });
  return map;
}
function filteredOrders() {
  var rows = state.orders.slice();
  if (orderTypeFilter) rows = rows.filter(function (o) { return orderTypeOf(o.stage) === orderTypeFilter; });
  if (orderCustomerFilter) rows = rows.filter(function (o) { return String(o.customer_company || '') === orderCustomerFilter; });
  if (orderStageFilter) rows = rows.filter(function (o) { return String(o.stage || '') === orderStageFilter; });
  if (orderSearchText) {
    var q = orderSearchText.toLowerCase();
    rows = rows.filter(function (o) {
      return ((o.customer_company || '') + ' ' + (o.customer_contact || '') + ' ' + (o.title || '') + ' ' + (o.order_no || '')).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) {
    var da = a.order_date || '', db = b.order_date || '';
    if (da !== db) return da < db ? 1 : -1; // 日期倒序（无日期的沉底）
    return String(a.order_no || '') < String(b.order_no || '') ? -1 : 1;
  });
  return rows;
}
// 类型 / 客户 / 阶段下拉由数据里实际出现的值生成；数据不变时不重建（不丢当前选择）。
// 新建表单的阶段下拉也用同一份阶段值；无数据时用已知的 9 个阶段兜底。
function syncOrderFilterOptions() {
  var types = [], seenT = {};
  var companies = [], seenC = {};
  var stages = [], seenS = {};
  state.orders.forEach(function (o) {
    var t = orderTypeOf(o.stage);
    if (t && !seenT[t]) { seenT[t] = true; types.push(t); }
    var co = String(o.customer_company || '').trim();
    if (co && !seenC[co]) { seenC[co] = true; companies.push(co); }
    var s = String(o.stage || '');
    if (s && !seenS[s]) { seenS[s] = true; stages.push(s); }
  });
  companies.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
  var sig = types.join('|') + '#' + companies.join('|') + '#' + stages.join('|');
  if (sig === orderFilterSig) return;
  orderFilterSig = sig;
  var typeSel = $('filterOrderType'), custSel = $('filterOrderCustomer'), stageSel = $('filterOrderStage');
  if (!typeSel || !custSel || !stageSel) return;
  var curT = typeSel.value, curC = custSel.value, curS = stageSel.value;
  typeSel.innerHTML = '<option value="">全部订单类型</option>' +
    types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
  custSel.innerHTML = '<option value="">全部客户</option>' +
    companies.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  stageSel.innerHTML = '<option value="">全部阶段</option>' +
    stages.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
  if (curT && seenT[curT]) typeSel.value = curT;
  if (curC && seenC[curC]) custSel.value = curC;
  if (curS && seenS[curS]) stageSel.value = curS;
  var formStage = document.querySelector('#orderForm [data-f="stage"]');
  if (formStage) {
    var opts = stages.length ? stages : ORDER_STAGES;
    var curF = formStage.value;
    formStage.innerHTML = opts.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
    if (curF && opts.indexOf(curF) !== -1) formStage.value = curF;
  }
}
// 利润栏三行：待确认绝不显示成 0 或数字。
//   第 1 行：已核对 ? “已核对” : “待确认”
//   第 2 行：已核对 ? “实际利润率 X%” : “实际利润率 —”
//   第 3 行：预计 ? “预计 ¥P · X%” : 已核对 ? “实际 ¥P · X%” : “预计 待确认 · —”
function orderProfitCell(o) {
  var verified = o.profit_status === '已核对';
  var estimated = o.profit_status === '预计';
  var rate = toNum(o.profit_rate);
  var profit = toNum(o.profit_rmb);
  var line1 = verified ? '已核对' : '待确认';
  var line2 = verified ? '实际利润率 ' + (rate !== null ? rate + '%' : '—') : '实际利润率 —';
  var line3;
  if (estimated) {
    line3 = '预计 ' + (profit !== null ? fmtCNY(profit) : '—') + ' · ' + (rate !== null ? rate + '%' : '—');
  } else if (verified) {
    line3 = '实际 ' + (profit !== null ? fmtCNY(profit) : '—') + ' · ' + (rate !== null ? rate + '%' : '—');
  } else {
    line3 = '预计 待确认 · —';
  }
  return '<div class="o-profit-state">' + esc(line1) + '</div>' +
    '<div class="c-sub">' + esc(line2) + '</div>' +
    '<div class="c-sub">' + esc(line3) + '</div>';
}

function orderRowHtml(o, confirmedMap) {
  var co = String(o.customer_company || '').trim();
  var confirmedN = confirmedMap[co] || 0;
  var amt = toNum(o.amount_usd), rec = toNum(o.received_usd);
  var rate = toNum(o.exchange_rate), cost = toNum(o.cost_rmb);
  return '<tr>' +
    '<td><div class="c-sub">' + esc(o.order_no || '') + '</div>' +
    '<div class="c-name">' + esc(o.title || '') + '</div>' +
    '<div class="c-sub">' + esc(fmtDate(o.order_date)) + (o.stage ? ' · ' + esc(o.stage) : '') + '</div></td>' +
    '<td>' + (co ? '<button class="link-btn" data-filter-order-customer="' + esc(co) + '" title="点击只看该客户的项目与订单">' + esc(co) + '</button>' : '<span class="c-sub">—</span>') +
    (o.customer_contact ? ' · ' + esc(o.customer_contact) : '') +
    '<div class="c-sub">累计 ' + confirmedN + ' 笔已确认订单</div></td>' +
    '<td><div class="c-name">' + esc(amt !== null ? fmtUSD(amt) : '—') + '</div>' +
    '<div class="c-sub">' + (rec !== null ? '已收 ' + fmtUSD(rec) : '已收 —') + '</div></td>' +
    '<td><div>' + (rate !== null ? esc(String(rate)) : '—') + '</div><div class="c-sub">每单独立设置</div></td>' +
    '<td><div class="c-name">' + esc(cost !== null ? fmtCNY(cost) : '—') + '</div>' +
    (o.cost_note ? '<div class="c-sub">' + esc(o.cost_note) + '</div>' : '') + '</td>' +
    '<td>' + orderProfitCell(o) + '</td></tr>';
}

function renderOrders() {
  var el = $('orderList');
  syncOrderFilterOptions();
  var pill = $('orderCountPill');
  if (pill) pill.textContent = state.orders.length;
  var rows = filteredOrders();
  var confirmedMap = confirmedCountByCompany();
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无项目与订单。' +
      (state.orders.length === 0 ? '请先在 Supabase 执行 supabase-followup.sql 建表，再按 README 用 import/import-orders-suppliers.py 导入。' : '试试换个搜索词或筛选条件。') + '</div>';
    return;
  }
  var html = '<table class="follow-table order-table"><thead><tr><th>项目 / 订单</th><th>客户 / 公司</th><th>销售总额 USD</th><th>本单汇率</th><th>已录实际成本 RMB</th><th>订单利润 RMB / 利润率</th></tr></thead><tbody>';
  rows.forEach(function (o) { html += orderRowHtml(o, confirmedMap); });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ---------- 供应商与物流（旧系统样式：宽松 4 列表格） ----------
// 空字段在库里的原文就是“待补充”/“联系方式待补充”/“联系人待补充”，原样显示；
// 新建时留空的字段也显示同一占位，不编造内容。
function filteredSuppliers() {
  var rows = state.suppliers.slice();
  if (supplierKindFilter) rows = rows.filter(function (s) { return String(s.kind || '') === supplierKindFilter; });
  if (supplierSearchText) {
    var q = supplierSearchText.toLowerCase();
    rows = rows.filter(function (s) {
      return ((s.name || '') + ' ' + (s.contact || '') + ' ' + (s.service_or_route || '')).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'); });
  return rows;
}

function renderSuppliers() {
  var el = $('supplierList');
  var pill = $('supplierCountPill');
  if (pill) pill.textContent = state.suppliers.length;
  var rows = filteredSuppliers();
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无供应商与物流。' +
      (state.suppliers.length === 0 ? '请先在 Supabase 执行 supabase-followup.sql 建表，再按 README 用 import/import-orders-suppliers.py 导入。' : '试试换个搜索词或筛选条件。') + '</div>';
    return;
  }
  var html = '<table class="follow-table supplier-table"><thead><tr><th>伙伴 / 类型</th><th>联系人与联系方式</th><th>材料、服务或物流线路</th><th>关联费用</th><th></th></tr></thead><tbody>';
  rows.forEach(function (s) {
    html += '<tr><td><div class="c-name">' + esc(s.name || '') + '</div>' +
      '<div class="c-sub">' + esc(s.kind || '') + '</div></td>' +
      '<td><div>' + esc(s.contact || '联系人待补充') + '</div>' +
      '<div class="c-sub">' + esc(s.contact_info || '联系方式待补充') + '</div></td>' +
      '<td>' + esc(s.service_or_route || '待补充') + '</td>' +
      '<td><div class="c-name">' + (parseInt(s.detail_count, 10) || 0) + ' 条明细</div></td>' +
      '<td class="chev">›</td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ---------- 经营汇总与报表 ----------
// 月份下拉由询盘日期 + 订单日期里实际出现的月份生成；默认取最晚的有活动月份。
function availableMonths() {
  var set = {};
  state.inquiries.forEach(function (q) { var m = monthKey(q.inquiry_date); if (m) set[m] = true; });
  state.orders.forEach(function (o) { var m = monthKey(o.order_date); if (m) set[m] = true; });
  return Object.keys(set).sort();
}
function syncSummaryMonthOptions() {
  var sel = $('summaryMonth');
  if (!sel) return;
  var months = availableMonths();
  var sig = months.join('|');
  if (sig === summaryMonthSig) return;
  summaryMonthSig = sig;
  if (!months.length) {
    sel.innerHTML = '<option value="">暂无数据</option>';
    summaryMonth = '';
    return;
  }
  if (!summaryMonth || months.indexOf(summaryMonth) === -1) summaryMonth = months[months.length - 1];
  sel.innerHTML = months.map(function (m) {
    return '<option value="' + esc(m) + '"' + (m === summaryMonth ? ' selected' : '') + '>' + esc(m) + '</option>';
  }).join('');
}
// 每日实际利润柱状图（纯 CSS div，不用图表库）：每天一根柱子，柱高按当日已核对利润，
// 数值写在日期下方；有订单但尚不可算的日子画一条灰色虚线（旧站图例同款）。
function renderSummaryChart(s) {
  var el = $('summaryChart');
  var max = 0;
  s.daily.forEach(function (d) { if (d.verifiedProfit > max) max = d.verifiedProfit; });
  el.innerHTML = s.daily.map(function (d) {
    var dayNum = parseInt(d.date.slice(8, 10), 10);
    var bar = '';
    if (d.verifiedProfit > 0) {
      var h = Math.max(3, Math.round(d.verifiedProfit / max * 110));
      bar = '<div class="bar" style="height:' + h + 'px" title="' + esc(d.date) + ' 已核对利润 ' + fmtCNY(d.verifiedProfit) + '"></div>';
    } else if (d.hasOrders) {
      bar = '<div class="bar-dash" title="' + esc(d.date) + ' 有订单但尚不可算"></div>';
    }
    var val = d.verifiedProfit > 0 ? fmtCNY(d.verifiedProfit) : '—';
    return '<div class="bar-col">' + bar + '<div class="bar-day">' + dayNum + '日</div><div class="bar-val">' + esc(val) + '</div></div>';
  }).join('');
}

function renderSummary() {
  syncSummaryMonthOptions();
  var titleEl = $('summaryTitle');
  if (!summaryMonth) {
    if (titleEl) titleEl.textContent = '经营汇总';
    $('sumInquiries').innerHTML = '0 <span class="unit">条</span>';
    $('sumConverted').innerHTML = '0 <span class="unit">位</span>';
    $('sumConvertedSub').textContent = '期间去重 · 0 笔已确认订单';
    $('sumSalesUsd').textContent = 'US$0.00';
    $('sumProfit').textContent = '¥0.00';
    $('sumProfitSub').textContent = '0 / 0 笔可计算';
    $('sumSalesCny').textContent = '¥0.00';
    $('sumSalesCnySub').textContent = '逐单用该订单汇率';
    $('sumEstProfit').textContent = '¥0.00';
    $('sumEstProfitSub').textContent = '0 / 0 笔可计算；与已核对利润分开查看';
    $('sumRate').textContent = '0.0%';
    $('sumRateSub').textContent = '本期收到的 0 条中，当前 0 条已成交';
    $('summaryChart').innerHTML = '<div class="empty">暂无数据。请先导入订单与询盘。</div>';
    $('summaryDaily').innerHTML = '<div class="empty">暂无数据。请先导入订单与询盘。</div>';
    return;
  }
  var s = computeMonthlySummary(state.orders, state.inquiries, state.history, state.customers, summaryMonth);
  var y = summaryMonth.slice(0, 4), m = parseInt(summaryMonth.slice(5, 7), 10);
  if (titleEl) titleEl.textContent = y + ' 年 ' + m + ' 月 经营汇总';
  $('sumInquiries').innerHTML = s.inquiries + ' <span class="unit">条</span>';
  $('sumConverted').innerHTML = s.convertedCustomers + ' <span class="unit">位</span>';
  $('sumConvertedSub').textContent = '期间去重 · ' + s.confirmedOrders + ' 笔已确认订单';
  $('sumSalesUsd').textContent = fmtUSD(s.salesUsd);
  $('sumProfit').textContent = fmtCNY(s.verifiedProfit);
  $('sumProfitSub').textContent = s.verifiedA + ' / ' + s.verifiedB + ' 笔可计算';
  $('sumSalesCny').textContent = fmtCNY(s.salesCny);
  $('sumSalesCnySub').textContent = '逐单用该订单汇率' + (s.missingSales ? '；待补 ' + s.missingSales + ' 笔（缺金额或汇率，不计为 0）' : '');
  $('sumEstProfit').textContent = fmtCNY(s.estimatedProfit);
  $('sumEstProfitSub').textContent = s.estA + ' / ' + s.estB + ' 笔可计算；与已核对利润分开查看';
  $('sumRate').textContent = s.conversionRate.toFixed(1) + '%';
  $('sumRateSub').textContent = '本期收到的 ' + s.conversionDen + ' 条中，当前 ' + s.conversionNum + ' 条已成交';
  renderSummaryChart(s);
  var rows = s.daily.map(function (d) {
    return '<tr><td>' + esc(d.date) + '</td><td>' + d.inquiries + '</td><td>' + d.converted + '</td><td>' + d.orders + '</td>' +
      '<td>' + esc(fmtUsd0(d.salesUsd)) + '</td><td>' + esc(fmtCny0(d.salesCny)) + '</td>' +
      '<td>' + esc(fmtCny0(d.verifiedProfit)) + '</td><td>' + esc(fmtCny0(d.estimatedProfit)) + '</td></tr>';
  }).join('');
  $('summaryDaily').innerHTML = '<table class="follow-table"><thead><tr><th>日期</th><th>询盘</th><th>成交客户</th><th>订单</th><th>销售额 USD</th><th>折算 CNY</th><th>已核对利润</th><th>预计利润</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderAll() {
  renderCards();
  renderFollowList();
  renderAllInquiries();
  renderTodos();
  renderCustomers();
  renderReview();
  renderOrders();
  renderSuppliers();
  renderSummary();
  renderProspects();
}

// ---------- 搜客池 Phase 1：列表 / 导入 / 转客户 ----------
// 列表按分数倒序；筛选：国家 / 分数段 / 状态 / 批次 + 搜索（公司、域名、联系人）。
// 版式按客户档案的宽松表格来，不做密表。
function prospectBandClass(band) {
  return band === '优先' ? 'band-hot' : band === '可跟' ? 'band-mid' : band === '备选' ? 'band-low' : 'band-out';
}
function filteredProspects() {
  var rows = state.prospects.slice();
  if (prospectCountryFilter) rows = rows.filter(function (c) { return String(c.country || '') === prospectCountryFilter; });
  if (prospectBandFilter) rows = rows.filter(function (c) { return scoreBand(c.score_total || 0) === prospectBandFilter; });
  if (prospectStatusFilter) rows = rows.filter(function (c) { return String(c.status || '') === prospectStatusFilter; });
  if (prospectBatchFilter) rows = rows.filter(function (c) { return String(c.batch_id || '') === prospectBatchFilter; });
  if (prospectSearchText) {
    var q = prospectSearchText.toLowerCase();
    rows = rows.filter(function (c) {
      return ((c.company || '') + ' ' + (c.domain || '') + ' ' + (c.contact_name || '') + ' ' + (c.contact_email || '')).toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) {
    var d = (b.score_total || 0) - (a.score_total || 0);
    if (d) return d;
    return String(a.company || '').localeCompare(String(b.company || ''), 'zh-CN');
  });
  return rows;
}
// 国家 / 批次下拉由数据里实际出现的值生成；数据不变时不重建（不丢当前选择）。
function syncProspectFilterOptions() {
  var countrySel = $('filterProspectCountry'), batchSel = $('filterProspectBatch');
  if (!countrySel || !batchSel) return;
  var countries = [], seenC = {};
  state.prospects.forEach(function (c) {
    var v = String(c.country || '').trim();
    if (v && !seenC[v]) { seenC[v] = true; countries.push(v); }
  });
  countries.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
  var batches = state.prospectBatches.slice();
  var sig = countries.join('|') + '#' + batches.map(function (b) { return b.id; }).join('|');
  if (sig === prospectFilterSig) return;
  prospectFilterSig = sig;
  var curC = countrySel.value, curB = batchSel.value;
  countrySel.innerHTML = '<option value="">全部国家</option>' +
    countries.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  batchSel.innerHTML = '<option value="">全部批次</option>' +
    batches.map(function (b) {
      var label = fmtDate(b.run_at || b.created_at) + ' · ' + (b.country || '多国') + ' ' + (b.keyword_group || '') + '（入池 ' + (b.pooled_count || 0) + '）';
      return '<option value="' + esc(b.id) + '">' + esc(label) + '</option>';
    }).join('');
  if (curC && seenC[curC]) countrySel.value = curC;
  if (curB && batches.some(function (b) { return String(b.id) === curB; })) batchSel.value = curB;
}

function prospectRowHtml(c) {
  var band = scoreBand(c.score_total || 0);
  var evUrl = c.evidence_url || (c.website || '');
  var evLink = evUrl ? '<a href="' + esc(evUrl) + '" target="_blank" rel="noopener">证据链接 ↗</a>' : '<span class="c-sub">—</span>';
  var excerpt = c.evidence_excerpt ? '<div class="ev-excerpt">' + esc(String(c.evidence_excerpt).slice(0, 120)) + '</div>' : '';
  var statusHtml = '<span class="badge ' +
    (c.status === '已转客户' ? 'done' : c.status === '已淘汰' ? 'pending' : c.status === '已保留' ? 'waiting' : 'review') +
    '">' + esc(c.status || '待复核') + '</span>';
  if (c.status === '已淘汰' && c.discard_reason) statusHtml += '<div class="c-sub">' + esc(c.discard_reason) + '</div>';
  if (c.status === '已转客户') statusHtml += '<div class="c-sub">已转入客户档案</div>';
  if (c.needs_human_check) statusHtml += '<div class="c-sub">图片质感判断，需人工复核</div>';
  var canConvert = (c.status === '待复核' || c.status === '已保留') && !!String(c.contact_email || '').trim();
  var actions = '';
  if (canConvert) actions += '<button class="small" data-convert-prospect="' + esc(c.id) + '">转客户</button>';
  else if (c.status === '待复核' || c.status === '已保留') actions += '<button class="small" disabled title="没有邮箱，无法转客户（先补一个决策人邮箱）">转客户</button>';
  if (c.status === '待复核' || c.status === '已保留') {
    actions += '<button class="small ghost" data-discard-prospect="' + esc(c.id) + '">淘汰</button>';
  }
  return '<tr>' +
    '<td><div class="c-name">' + esc(c.company || '未知公司') + '</div>' +
    (c.domain ? '<div class="c-sub"><a href="' + esc(c.website || ('https://' + c.domain)) + '" target="_blank" rel="noopener">' + esc(c.domain) + ' ↗</a></div>' : '') +
    (c.contact_name || c.contact_email ? '<div class="c-sub">' + esc(c.contact_name || '') + (c.contact_role ? ' · ' + esc(c.contact_role) : '') + (c.contact_email ? ' · ' + esc(c.contact_email) : '') + '</div>' : '') +
    '</td>' +
    '<td><div>' + esc(c.country || '—') + '</div>' +
    '<div class="c-sub">' + esc(c.size_text || (c.size_min != null ? c.size_min + (c.size_max && c.size_max !== c.size_min ? '-' + c.size_max : '') + ' 人' : '规模未提供')) + '</div>' +
    '<div class="c-sub">' + esc(c.product_category || '') + (c.product_line ? ' · ' + esc(c.product_line) : '') + '</div></td>' +
    '<td><div class="score-num">' + (c.score_total == null ? '—' : c.score_total) + '</div>' +
    '<span class="badge ' + prospectBandClass(band) + '">' + band + '</span>' +
    '<div class="score-sub">证据 ' + (c.score_evidence || 0) + ' · 匹配 ' + (c.score_fit || 0) + ' · 定制 ' + (c.score_oem || 0) + '<br>联系 ' + (c.score_contact || 0) + ' · 规模 ' + (c.score_size || 0) + ' · 完整 ' + (c.score_completeness || 0) + '</div></td>' +
    '<td>' + evLink + excerpt + '</td>' +
    '<td>' + statusHtml + '</td>' +
    '<td><div class="row-actions">' + actions + '</div></td></tr>';
}

function renderProspects() {
  var batchEl = $('prospectBatchList'), listEl = $('prospectList');
  if (!batchEl || !listEl) return;
  syncProspectFilterOptions();
  var pill = $('prospectCountPill');
  if (pill) pill.textContent = state.prospects.length;
  // 批次：时间 / 国家 / 关键词组 / 来源 / 原始-淘汰-入池三数
  if (!state.prospectBatches.length) {
    batchEl.innerHTML = '<div class="empty">还没有导入过名单。上面选好国家、关键词组和来源，导入一个 Excel 名单就能看到批次。</div>';
  } else {
    var bh = '<table class="follow-table"><thead><tr><th>批次时间</th><th>国家</th><th>关键词组</th><th>来源</th><th>原始</th><th>淘汰</th><th>入池</th><th>备注</th></tr></thead><tbody>';
    state.prospectBatches.forEach(function (b) {
      bh += '<tr><td>' + esc(fmtDate(b.run_at || b.created_at)) + '</td><td>' + esc(b.country || '—') + '</td>' +
        '<td>' + esc(b.keyword_group || '—') + '</td><td>' + esc(b.source || '') + '</td>' +
        '<td>' + (b.raw_count || 0) + '</td><td>' + (b.discarded_count || 0) + '</td><td>' + (b.pooled_count || 0) + '</td>' +
        '<td class="c-sub">' + esc(b.note || '') + '</td></tr>';
    });
    batchEl.innerHTML = bh + '</tbody></table>';
  }
  var rows = filteredProspects();
  var countEl = $('prospectListCount');
  if (countEl) countEl.textContent = '（' + rows.length + ' 条）';
  if (!rows.length) {
    listEl.innerHTML = '<div class="empty">这个筛选下暂无候选。' +
      (state.prospects.length === 0 ? '请先导入一个 Excel 名单（支持 .xlsx / .csv，第一行为表头）。' : '试试换个搜索词或筛选条件。') + '</div>';
    return;
  }
  var html = '<table class="cust-table"><thead><tr><th>公司 / 联系人</th><th>国家 · 规模 · 产品</th><th>分数</th><th>证据</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  rows.forEach(function (c) { html += prospectRowHtml(c); });
  html += '</tbody></table>';
  listEl.innerHTML = html;
}

// 搜客池页的状态行（导入/转客户/淘汰的反馈，写在表格上方，不动顶部的全局状态行）。
function setProspectStatus(msg, isError) {
  var el = $('prospectStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}
function newUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ---------- 搜客池：导入 Excel 名单 ----------
// 流程：读文件（第一张表）→ 自动识别列名 → 预览（映射 + 行数 + 前 5 行的预计结果）→
//   点“确认导入”才写库。导入本身只在跟进系统里清洗/去重/打分，不连任何外部服务。
function handleProspectFile(file) {
  if (!file) return;
  var name = String(file.name || '').toLowerCase();
  var meta = {
    country: ($('prospectBatchCountry') ? $('prospectBatchCountry').value.trim() : ''),
    keywordGroup: ($('prospectBatchKeywords') ? $('prospectBatchKeywords').value.trim() : ''),
    source: ($('prospectBatchSource') ? $('prospectBatchSource').value : '手工导入')
  };
  var done = function (rawRows) {
    if (!rawRows || !rawRows.length) { setProspectStatus('文件里没有数据行（第一行为表头）。', true); return; }
    var headers = Object.keys(rawRows[0] || {});
    var mapping = detectProspectColumns(headers);
    if (!mapping.company && !mapping.domain) {
      setProspectStatus('没识别出公司/域名列：请确认第一行是表头，且包含“公司”“域名”或“官网”列。已识别的列：' + (Object.keys(mapping).join('、') || '无'), true);
      return;
    }
    var rows = rawRows.map(function (r) { return normalizeProspectRow(r, mapping); });
    var result = processProspectImport(rows, state.customers, state.prospects);
    pendingProspectImport = { rows: rows, mapping: mapping, meta: meta, result: result, fileName: file.name };
    renderProspectImportPreview();
  };
  setProspectStatus('正在读取 ' + file.name + '……');
  if (name.endsWith('.csv')) {
    file.text().then(function (txt) { done(parseCsvText(txt)); })
      .catch(function (e) { setProspectStatus('读取文件失败：' + e.message, true); });
  } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    var readXlsx = function (XLSX) {
      return file.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(buf, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        done(XLSX.utils.sheet_to_json(ws, { defval: '' }));
      });
    };
    if (typeof window !== 'undefined' && window.XLSX) readXlsx(window.XLSX)
      .catch(function (e) { setProspectStatus('读取文件失败：' + e.message, true); });
    else loadSheetJS().then(readXlsx)
      .catch(function (e) { setProspectStatus('导入失败：表格组件未能加载（' + e.message + '），可以先把文件另存为 .csv 再导入。', true); });
  } else {
    setProspectStatus('只支持 .xlsx / .csv 文件。', true);
  }
  var fi = $('importProspectFile');
  if (fi) fi.value = ''; // 允许下次再选同一个文件
}
// 导入预览：识别出的列映射 + 行数 + 前 5 行的预计结果（入池/淘汰/跳过 + 分数），确认后才写库。
function renderProspectImportPreview() {
  var el = $('prospectImportPreview');
  if (!el) return;
  if (!pendingProspectImport) { el.innerHTML = ''; return; }
  var p = pendingProspectImport;
  var r = p.result;
  var mapLines = Object.keys(p.mapping).map(function (f) { return esc(f) + ' ← ' + esc(p.mapping[f]); }).join('；');
  var covHit = findProspectCoverageHit(p.meta.country, p.meta.keywordGroup, state.prospectCoverage);
  var covNote = covHit ? '<div class="c-sub">提示：' + esc(p.meta.country || '该国家') + ' + ' + esc(p.meta.keywordGroup || '该关键词组') + ' 之前已搜过（' + esc(fmtDate(covHit.searched_at)) + '，已见 ' + (covHit.domains_seen || []).length + ' 个域名），本批仍会导入，但去重会跳过已见过的公司。</div>' : '';
  var previewRows = p.rows.slice(0, 5).map(function (row) {
    var hard = checkProspectHardRules(row);
    var outcome, scoreTxt = '—';
    if (!hard.ok) outcome = '淘汰：' + hard.reason;
    else {
      var dup = findProspectDuplicate(row, state.customers, state.prospects);
      if (dup) outcome = '跳过：' + dup.kind + '已存在于' + dup.where;
      else {
        var sc = scoreProspect(detectProspectSignals(row));
        scoreTxt = String(sc.total);
        outcome = scoreBand(sc.total) + '（' + classifyProspect(sc.total, '').status + '）';
      }
    }
    return '<tr><td>' + esc(row.company || '') + '</td><td>' + esc(row.domain || '') + '</td><td>' + esc(row.country || '') + '</td><td>' + scoreTxt + '</td><td>' + esc(outcome) + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="review-card"><div class="r-subject">导入预览：' + esc(p.fileName) + '</div>' +
    '<div class="r-meta">识别出的列：' + mapLines + '</div>' +
    '<div class="r-meta">国家：' + esc(p.meta.country || '（按行取）') + ' · 关键词组：' + esc(p.meta.keywordGroup || '（未填）') + ' · 来源：' + esc(p.meta.source) + '</div>' +
    '<div>总行数 ' + p.rows.length + ' 行 → 预计入池 ' + r.pooled.length + ' 条，淘汰 ' + r.rejected.length + ' 条，去重跳过 ' + r.skipped.length + ' 条。</div>' +
    covNote +
    '<table class="follow-table" style="margin-top:10px"><thead><tr><th>公司</th><th>域名</th><th>国家</th><th>分数</th><th>预计结果</th></tr></thead><tbody>' + previewRows + '</tbody></table>' +
    '<div class="row-actions"><button class="small" data-confirm-prospect-import>确认导入</button>' +
    '<button class="small ghost" data-cancel-prospect-import>取消</button></div></div>';
  setProspectStatus('预览已生成：总 ' + p.rows.length + ' 行，预计入池 ' + r.pooled.length + ' 条，淘汰 ' + r.rejected.length + ' 条，去重跳过 ' + r.skipped.length + ' 条。核对无误再点“确认导入”。');
}
// 站内搜索（Phase 2）：关键词 + 国家调 /api/prospect-search，结果喂给导入预览/确认流程。
async function handleProspectSearch() {
  var keywordEl = document.getElementById('prospectSearchKeyword');
  var countryEl = document.getElementById('prospectSearchCountry');
  var keyword = keywordEl ? keywordEl.value.trim() : '';
  var country = countryEl ? countryEl.value.trim() : '';
  if (!keyword) { setProspectStatus('请先输入搜索关键词。', true); return; }
  if (!country) { setProspectStatus('请先输入国家。', true); return; }
  setProspectStatus('站内搜索中…');
  try {
    var res = await fetch('/api/prospect-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: keyword, country: country }) });
    var data = await res.json();
    if (!data || !data.ok) { setProspectStatus('站内搜索失败：' + (data && data.error ? data.error : '未知错误'), true); return; }
    var rows = normalizeProspectSearchCompanies(data.companies || []);
    var result = processProspectImport(rows, state.customers, state.prospects);
    var mapping = {};
    ['company', 'domain', 'website', 'country', 'contact_email', 'contact_name', 'contact_role', 'product_category', 'industry', 'size_text', 'size_min', 'size_max', 'evidence_url', 'evidence_excerpt', 'evidence_level', 'source', 'quality_notes', 'notes'].forEach(function (f) { mapping[f] = f; });
    pendingProspectImport = { rows: rows, mapping: mapping, meta: prospectSearchImportMeta(keyword, country), result: result, fileName: '站内搜索：' + keyword + ' / ' + country };
    renderProspectImportPreview();
    setProspectStatus('站内搜索完成：' + (data.note || ('找到 ' + rows.length + ' 家公司，请在预览里确认导入。')));
  } catch (err) {
    setProspectStatus('站内搜索失败：' + (err && err.message ? err.message : '网络错误'), true);
  }
}
// 确认导入：先写批次，再批量写候选（自带 UUID，联系人直接关联），最后更新覆盖记忆。
function confirmProspectImport() {
  var p = pendingProspectImport;
  if (!p) return;
  if (!hasKey) { alert('未配置 Supabase key，无法导入'); return; }
  var r = p.result;
  var batchId = newUuid();
  var now = new Date().toISOString();
  setProspectStatus('正在导入 ' + r.pooled.length + ' 条候选……');
  var discardReasons = {};
  r.rejected.forEach(function (x) { var k = String(x.reason).split('：')[0]; discardReasons[k] = (discardReasons[k] || 0) + 1; });
  var skipReasons = {};
  r.skipped.forEach(function (x) { var k = String(x.reason).split('：')[0]; skipReasons[k] = (skipReasons[k] || 0) + 1; });
  var noteParts = [];
  Object.keys(discardReasons).forEach(function (k) { noteParts.push('淘汰 ' + k + ' ' + discardReasons[k] + ' 条'); });
  Object.keys(skipReasons).forEach(function (k) { noteParts.push('去重跳过 ' + k + ' ' + skipReasons[k] + ' 条'); });
  var batch = {
    id: batchId, country: p.meta.country || '', keyword_group: p.meta.keywordGroup || '',
    source: p.meta.source || '手工导入', run_at: now,
    raw_count: p.rows.length, discarded_count: r.rejected.length + r.skipped.length,
    pooled_count: r.pooled.length, note: noteParts.join('；')
  };
  sbInsert('prospect_batches', batch).then(function () {
    var candidates = r.pooled.map(function (c) {
      var row = Object.assign({}, c, { id: newUuid(), batch_id: batchId });
      return row;
    });
    var insertCandidates = candidates.length
      ? sb('prospect_candidates', { method: 'POST', body: candidates }).catch(function () {
          // 整批失败再逐条插（与客户导入同一做法），逐条失败的计入失败数
          var chain = Promise.resolve();
          var okRows = [];
          candidates.forEach(function (row) {
            chain = chain.then(function () {
              return sbInsert('prospect_candidates', row).then(function (ins) { if (ins && ins[0]) okRows.push(ins[0]); }).catch(function () { /* 失败的跳过 */ });
            });
          });
          return chain.then(function () { return okRows; });
        })
      : Promise.resolve([]);
    return insertCandidates.then(function (inserted) {
      var byDomain = {};
      (Array.isArray(inserted) ? inserted : []).forEach(function (c) { if (c && c.domain) byDomain[normalizeDomain(c.domain)] = c; });
      candidates.forEach(function (c) { if (!byDomain[c.domain]) byDomain[c.domain] = c; });
      // 联系人：主联系人有邮箱/姓名才建一条（决策人优先标记）；无联系信息的候选不建空行
      var contacts = [];
      r.pooled.forEach(function (cand) {
        var saved = byDomain[cand.domain];
        if (!saved) return;
        if (cand.contact_email || cand.contact_name) {
          contacts.push({
            candidate_id: saved.id, name: cand.contact_name || '', role: cand.contact_role || '',
            email: cand.contact_email || '', phone: cand.contact_phone || '',
            verification_status: 'unverified', source: p.meta.source || '手工导入',
            is_decision_maker: cand.contact_type === 'named'
          });
        }
      });
      var insertContacts = contacts.length
        ? sb('prospect_contacts', { method: 'POST', body: contacts }).catch(function () { return []; })
        : Promise.resolve([]);
      return insertContacts.then(function () {
        // 覆盖记忆：同一国家+关键词组只留一条，域名并集；只提示、不拦截
        var domains = candidates.map(function (c) { return c.domain; }).filter(function (d) { return !!d; });
        var hit = findProspectCoverageHit(p.meta.country, p.meta.keywordGroup, state.prospectCoverage);
        if (hit) {
          var merged = (hit.domains_seen || []).slice();
          domains.forEach(function (d) { if (merged.indexOf(d) === -1) merged.push(d); });
          return sbUpdate('prospect_coverage', hit.id, { domains_seen: merged, searched_at: now, updated_at: now });
        }
        if (p.meta.country || p.meta.keywordGroup) {
          return sbInsert('prospect_coverage', {
            country: p.meta.country || '', keyword_group: p.meta.keywordGroup || '',
            source: p.meta.source || '手工导入', domains_seen: domains, searched_at: now
          });
        }
        return null;
      });
    });
  }).then(function () {
    pendingProspectImport = null;
    renderProspectImportPreview();
    setProspectStatus('导入完成：原始 ' + batch.raw_count + ' 行，入池 ' + batch.pooled_count + ' 条，淘汰/跳过 ' + batch.discarded_count + ' 条。' + (batch.note ? '（' + batch.note + '）' : ''));
    loadAll();
  }).catch(function (e) {
    setProspectStatus('导入失败：' + e.message, true);
  });
}

// 转客户：复用现有去重（撞上已有客户直接提示是哪一位，不重复建）、
//   标签约定（产品｜行业｜年月）+ 转入后第一条待办 +3 天。
// 转入时建一条新询盘（新询盘 / 未回复·等待客户 / 下次跟进 +3 天）；
//   候选状态改为 已转客户，并记下转成的客户/询盘 id。
function convertProspectToCustomer(candidateId) {
  var cand = null;
  state.prospects.forEach(function (c) { if (String(c.id) === String(candidateId)) cand = c; });
  if (!cand) return;
  if (!cand.contact_email) { alert('该候选没有邮箱，无法转客户（先补一个决策人邮箱）。'); return; }
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var dup = findDuplicateCustomer(state.customers, cand.contact_email, cand.company);
  if (dup) {
    alert('已存在相同客户，不重复创建：' + (dup.company || dup.name || '') + '（' + (dup.email || '') + '）\n' +
      '命中原因：邮箱相同，或同一家公司用了同一个企业邮箱域名。\n' +
      '请在客户档案里找到这位客户继续跟进。');
    return;
  }
  var today = todayStr();
  var due = addDays(today, FOLLOWUP_DELAY_DAYS);
  var product = cand.product_category || '潜水料';
  // 标签：产品｜行业｜年月（只有已知的段才拼，不编造行业）；另加一个“搜客池”来源标签。
  var tagParts = [product];
  if (String(cand.industry || '').trim()) tagParts.push(String(cand.industry).trim());
  tagParts.push(today.slice(0, 7));
  var tags = [tagParts.join('｜'), '搜客池'];
  var customer = {
    name: cand.contact_name || cand.company || '', company: cand.company || '',
    email: normalizeEmail(cand.contact_email), country: cand.country || '',
    website: cand.website || '', phone: cand.contact_phone || '',
    whatsapp: cand.contact_whatsapp || '', stage: '待评估',
    verification_status: cand.verification_status || 'unverified',
    tags: tags, outreach_count: 0, read_count: 0, health_score: 50,
    last_contact_at: null, next_followup_at: due,
    next_action: '搜客池转入：跟进' + product + '的询盘',
    source: '搜客池',
    notes: '搜客池转入；证据：' + (cand.evidence_url || cand.website || '')
  };
  setProspectStatus('正在转客户：' + (cand.company || '') + '……');
  sbInsert('followup_customers', customer).then(function (inserted) {
    var fresh = inserted && inserted[0] ? inserted[0] : customer;
    state.customers.unshift(fresh);
    var inquiry = {
      customer_id: fresh.id, product: product, quantity: '',
      summary: '', status: '待处理', stage: '新询盘', reply_status: '未回复 · 等待客户',
      inquiry_date: today, first_inquiry_at: new Date().toISOString(),
      next_action: customer.next_action, next_followup_at: due, next_followup_confirmed: true
    };
    return sbInsert('followup_inquiries', inquiry).then(function (ins2) {
      var freshInq = ins2 && ins2[0] ? ins2[0] : inquiry;
      state.inquiries.unshift(freshInq);
      // 转客户后第一条待办 +3 天（与 FOLLOWUP_DELAY_DAYS 一致）
      createFollowupTodo(freshInq, customer.next_action, due);
      return sbUpdate('prospect_candidates', cand.id, {
        status: '已转客户', converted_customer_id: fresh.id,
        converted_inquiry_id: freshInq.id || null, updated_at: new Date().toISOString()
      }).then(function (updated) {
        var freshCand = updated && updated[0] ? updated[0] : Object.assign({}, cand, { status: '已转客户' });
        state.prospects = state.prospects.map(function (x) { return String(x.id) === String(cand.id) ? freshCand : x; });
        setProspectStatus('已转客户：' + (cand.company || '') + '（' + (fresh.email || '') + '），已建询盘与 +3 天待办（到期 ' + due + '）。');
        renderAll();
      });
    });
  }).catch(function (e) {
    setProspectStatus('转客户失败：' + e.message, true);
  });
}

// 人工淘汰：状态改为 已淘汰并记原因（原因写进 discard_reason，下次再搜到直接跳过）。
function discardProspect(candidateId) {
  var cand = null;
  state.prospects.forEach(function (c) { if (String(c.id) === String(candidateId)) cand = c; });
  if (!cand) return;
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var reason = prompt('淘汰 ' + (cand.company || '') + ' 的原因：', cand.discard_reason || '人工淘汰');
  if (reason === null) return; // 点了取消
  reason = String(reason).trim() || '人工淘汰';
  sbUpdate('prospect_candidates', candidateId, { status: '已淘汰', discard_reason: reason, updated_at: new Date().toISOString() })
    .then(function (updated) {
      var fresh = updated && updated[0] ? updated[0] : Object.assign({}, cand, { status: '已淘汰', discard_reason: reason });
      state.prospects = state.prospects.map(function (x) { return String(x.id) === String(candidateId) ? fresh : x; });
      setProspectStatus('已淘汰：' + (cand.company || '') + '（' + reason + '）。');
      renderAll();
    })
    .catch(function (e) { setProspectStatus('淘汰失败：' + e.message, true); });
}

// ---------- 保存 / 人工复核 ----------
function saveInquiry(id) {
  var inq = inquiryById(id);
  if (!inq) return;
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var createTodo = !$('editCreateTodo') || $('editCreateTodo').checked; // v3：默认勾选
  var nextDate = $('editNext').value || null;
  var patch = {
    stage: $('editStage').value,
    next_action: $('editAction').value.trim(),
    next_followup_at: nextDate,
    updated_at: new Date().toISOString()
  };
  editingId = null;
  sbUpdate('followup_inquiries', id, patch).then(function (updated) {
    var fresh = updated && updated[0] ? updated[0] : Object.assign({ id: id }, patch);
    state.inquiries = state.inquiries.map(function (x) { return String(x.id) === String(id) ? fresh : x; });
    // v3：写跟进默认建待办（到期日 = 下次跟进日期，未填则今天 +3 天）；取消勾选则不建。
    if (createTodo) {
      createFollowupTodo(fresh, patch.next_action, nextDate || addDays(todayStr(), DEFAULT_TODO_DAYS));
    }
    renderAll();
  }).catch(function (e) { alert('保存失败：' + e.message); });
}

// 确认一条“待判断”：把询盘的 reply_status 改为已处理，下次跟进往后推 FOLLOWUP_DELAY_DAYS 天。
function confirmInquiryReview(inquiryId, cardEl) {
  var inq = inquiryById(inquiryId);
  if (!inq) return;
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var intent = cardEl.querySelector('[data-intent]').value;
  var base = inq.last_reply_at ? String(inq.last_reply_at).slice(0, 10) : todayStr();
  var patch = {
    reply_status: '已回复 · 已处理',
    next_followup_at: addDays(base, FOLLOWUP_DELAY_DAYS),
    next_action: '已确认客户回复（意向：' + (INTENT_LABELS[intent] || intent) + '），按此推进',
    updated_at: new Date().toISOString()
  };
  if (inq.status === '回复待判断') patch.status = '待处理';
  sbUpdate('followup_inquiries', inquiryId, patch).then(function (updated) {
    var fresh = updated && updated[0] ? updated[0] : Object.assign({ id: inquiryId }, patch);
    state.inquiries = state.inquiries.map(function (x) { return String(x.id) === String(inquiryId) ? fresh : x; });
    // v3：回信自动停 + 阅读计数。注意：这里只停待办、记一次已读，
    // 不把回复标为“已处理”之外的状态——人工确认本身就是处理，待办停掉即是目的。
    autoStopTodosForInquiry(inquiryId, inq.customer_id).then(function (n) {
      setStatus('已确认 1 条回复：意向为“' + (INTENT_LABELS[intent] || intent) + '”，下次跟进已推后 ' + FOLLOWUP_DELAY_DAYS + ' 天' +
        (n > 0 ? '；已自动停止 ' + n + ' 条未完成的跟进待办。' : '。'));
    });
    bumpCounter(inq.customer_id, 'read_count');
    renderAll();
  }).catch(function (e) { alert('保存失败：' + e.message); });
}

function confirmReview(emailId, cardEl) {
  var email = null;
  state.emails.forEach(function (e) { if (String(e.id) === String(emailId)) email = e; });
  if (!email) return;
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var intent = cardEl.querySelector('[data-intent]').value;
  var sentDate = email.sent_at ? String(email.sent_at).slice(0, 10) : todayStr();
  var patch = { intent: intent, intent_confidence: 'high', needs_review: false };
  sbUpdate('followup_emails', emailId, patch).then(function () {
    Object.assign(email, patch);
    var inq = inquiryById(email.inquiry_id);
    if (!inq) { renderAll(); return; }
    var inqPatch = {
      reply_status: '已回复 · 已处理',
      last_reply_at: email.sent_at,
      next_followup_at: addDays(sentDate, FOLLOWUP_DELAY_DAYS),
      next_action: '已确认客户回复（意向：' + (INTENT_LABELS[intent] || intent) + '），按此推进',
      updated_at: new Date().toISOString()
    };
    if (inq.status === '回复待判断') inqPatch.status = '待处理';
    return sbUpdate('followup_inquiries', inq.id, inqPatch).then(function (updated) {
      var fresh = updated && updated[0] ? updated[0] : Object.assign({ id: inq.id }, inqPatch);
      state.inquiries = state.inquiries.map(function (x) { return String(x.id) === String(inq.id) ? fresh : x; });
      // v3：回信自动停 + 阅读计数（同 confirmInquiryReview）。
      autoStopTodosForInquiry(inq.id, inq.customer_id).then(function (n) {
        setStatus('已确认 1 条回复：意向为“' + (INTENT_LABELS[intent] || intent) + '”，下次跟进已推后 ' + FOLLOWUP_DELAY_DAYS + ' 天' +
          (n > 0 ? '；已自动停止 ' + n + ' 条未完成的跟进待办。' : '。'));
      });
      bumpCounter(inq.customer_id, 'read_count');
      renderAll();
    });
  }).catch(function (e) { alert('保存失败：' + e.message); });
}

// ---------- 在系统内回邮件 ----------
// replyingTo = { inquiryId, emailId }：当前打开回复框的那条询盘/原邮件；
// 与 editingId 一样是跨 renderAll 保留的模块级状态，发送成功或取消后清掉。
var replyingTo = null;
// 回复草稿：点“发送”后先存草稿进确认态（页面内确认，不用浏览器原生 confirm，
// 原生弹窗会被浏览器自动化自动关掉，之前测试就卡在这里）；确认态/编辑态切换、
// 发送失败回编辑态时，已填的内容都从这里恢复，不会丢。
var replyDraft = null;

// 回复框：上面是原邮件（回复哪封就显示哪封），下面是收件人/主题/正文/下次跟进。
// 只发给当前这一个客户，不做群发；收件人默认是原邮件发件人（或客户档案邮箱），
// 服务端还会再核对一次，不在往来邮箱里的收件人会被拒绝。
function replyBoxHtml(inq, email) {
  var cust = customerById(inq.customer_id) || {};
  var emailId = email ? email.id : '';
  // 草稿属于这个框（同询盘+同邮件）时，编辑态用草稿回填，确认态直接显示确认面板。
  var draft = (replyDraft && String(replyDraft.inquiryId) === String(inq.id) && String(replyDraft.emailId || '') === String(emailId || '')) ? replyDraft : null;
  if (draft && draft.confirming) {
    var confirmText = '收件人：' + draft.to + '\n主题：' + draft.subject + '\n下次跟进：' + (draft.next || '今天 +3 天') + '\n正文：\n' + draft.body;
    return '<div class="reply-box" data-reply-box data-inquiry="' + esc(inq.id) + '" data-email="' + esc(emailId) + '">' +
      '<div class="r-orig">' + esc(confirmText) + '</div>' +
      '<div class="row-actions"><button class="small" data-confirm-send>确认发送</button>' +
      '<button class="small ghost" data-back-to-edit>返回修改</button>' +
      '<button class="small ghost" data-cancel-reply>取消</button></div></div>';
  }
  var to = draft ? draft.to : (email ? (email.from_email || '') : (cust.email || ''));
  var subject = draft ? draft.subject : (email ? ('Re: ' + (email.subject || '')) : ('Re: ' + (inq.product || inq.inquiry_no || '')));
  var body = draft ? draft.body : '';
  var next = draft ? draft.next : addDays(todayStr(), FOLLOWUP_DELAY_DAYS);
  var orig = email
    ? ('原邮件：' + (email.subject || '（无主题）') + '（' + (email.from_email || '') + '，' + fmtDate(email.sent_at) + '）\n' + (email.body_text || email.snippet || ''))
    : ('最近回复：' + (inq.reply_snippet || '（无）'));
  return '<div class="reply-box" data-reply-box data-inquiry="' + esc(inq.id) + '" data-email="' + esc(emailId) + '">' +
    '<div class="r-orig">' + esc(orig) + '</div>' +
    '<label class="muted">收件人（只发给这一个客户）</label><input type="text" data-rf="to" value="' + esc(to) + '">' +
    '<label class="muted">主题</label><input type="text" data-rf="subject" value="' + esc(subject) + '">' +
    '<label class="muted">正文</label><textarea data-rf="body" rows="6" placeholder="写给客户的正文（纯文本）">' + esc(body) + '</textarea>' +
    '<label class="muted">下次跟进日期（默认今天 +3 天，可改）</label><input type="date" data-rf="next" value="' + esc(next) + '">' +
    '<div class="row-actions"><button class="small" data-send-reply>发送</button>' +
    '<button class="small ghost" data-cancel-reply>取消</button></div></div>';
}

// 发送分两步，全部在页面里完成，不用浏览器原生 confirm（原生弹窗会被自动化关掉）：
// 第一步点“发送”：校验后把内容存进草稿进确认态，框里显示收件人/主题/正文/下次跟进；
// 第二步点“确认发送”才真正发。只在用户点发送时才发，绝不自动发。发完询盘进“等待客户”，下次跟进按框里的日期。
function sendReply(boxEl) {
  var inquiryId = boxEl.getAttribute('data-inquiry');
  var emailId = boxEl.getAttribute('data-email') || '';
  var to = boxEl.querySelector('[data-rf="to"]').value.trim();
  var subject = boxEl.querySelector('[data-rf="subject"]').value.trim();
  var body = boxEl.querySelector('[data-rf="body"]').value;
  var next = boxEl.querySelector('[data-rf="next"]').value || '';
  if (!to || !subject || !body.trim()) { alert('收件人、主题、正文都要填'); return; }
  replyDraft = { inquiryId: inquiryId, emailId: emailId, to: to, subject: subject, body: body, next: next, confirming: true };
  renderAll();
}

// 确认态点“确认发送”：用草稿里的内容调 /api/send-email。
function doSendReply(boxEl) {
  var draft = replyDraft;
  if (!draft) { alert('草稿找不到了，请重新填写再发送'); return; }
  var inquiryId = draft.inquiryId;
  var emailId = draft.emailId || '';
  var btn = boxEl.querySelector('[data-confirm-send]');
  btn.disabled = true;
  btn.textContent = '发送中……';
  fetch('/api/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inquiryId: inquiryId, to: draft.to, subject: draft.subject, body: draft.body, nextFollowupAt: draft.next || undefined, emailId: emailId || undefined })
  }).then(function (res) {
    return res.json().then(function (b) { return { status: res.status, body: b }; });
  }).then(function (r) {
    if (!r.body || !r.body.ok) {
      btn.disabled = false;
      btn.textContent = '确认发送';
      alert('发送失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
      replyDraft.confirming = false;
      renderAll();
      return;
    }
    var patch = { reply_status: r.body.reply_status, next_followup_at: r.body.next_followup_at, next_followup_confirmed: true, next_action: '已发邮件，等客户回复' };
    state.inquiries = state.inquiries.map(function (x) { return String(x.id) === String(inquiryId) ? Object.assign({}, x, patch) : x; });
    if (emailId) { state.emails.forEach(function (e) { if (String(e.id) === String(emailId)) e.needs_review = false; }); }
    var to = draft.to;
    replyDraft = null;
    replyingTo = null;
    renderAll();
    setStatus('已发送给 ' + to + '，询盘已进“等待客户”，下次跟进 ' + r.body.next_followup_at + (r.body.todoCreated ? '，已建待办。' : '。'));
  }).catch(function (e) {
    btn.disabled = false;
    btn.textContent = '确认发送';
    alert('发送失败：' + e.message);
    replyDraft.confirming = false;
    renderAll();
  });
}

function addCustomer() {
  var fields = {};
  document.querySelectorAll('#customerForm [data-f]').forEach(function (inp) { fields[inp.dataset.f] = inp.value.trim(); });
  if (!fields.name || !fields.email) { alert('请至少填写客户姓名和邮箱（邮箱用于匹配邮件）'); return; }
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  // v3：保存前去重。邮箱小写相同，或同一家公司 + 同一非免费邮箱域名，都不重复建；
  // 命中时直接告诉你已存在的是哪一位，并返回已有条数，不静默覆盖。
  var dup = findDuplicateCustomer(state.customers, fields.email, fields.company);
  if (dup) {
    alert('已存在相同客户，不重复创建：' + (dup.company || dup.name || '') + '（' + (dup.email || '') + '）\n' +
      '命中原因：邮箱相同，或同一家公司用了同一个企业邮箱域名。\n' +
      '请在客户档案里找到这位客户继续跟进。现有客户 ' + state.customers.length + ' 位，本次新增 0 位。');
    return;
  }
  var customer = {
    name: fields.name, company: fields.company || '', email: normalizeEmail(fields.email),
    country: fields.country || '', phone: fields.phone || '', stage: '待评估',
    // v3：邮箱验证状态（默认未验证）与标签（逗号分隔，约定 产品｜行业｜年月）
    verification_status: fields.verification_status || 'unverified',
    tags: normalizeTags(fields.tags),
    outreach_count: 0, read_count: 0,
    health_score: 50, last_contact_at: null, next_followup_at: null,
    next_action: fields.product ? '跟进' + fields.product + '的询盘' : '', notes: ''
  };
  sbInsert('followup_customers', customer).then(function (inserted) {
    var fresh = inserted && inserted[0] ? inserted[0] : customer;
    state.customers.unshift(fresh);
    if (fields.product) {
      return sbInsert('followup_inquiries', {
        customer_id: fresh.id, product: fields.product, quantity: '',
        summary: '', status: '待处理', stage: '新询盘', reply_status: '未回复 · 等待客户',
        first_inquiry_at: new Date().toISOString(),
        next_action: customer.next_action
      }).then(function (ins2) {
        if (ins2 && ins2[0]) state.inquiries.unshift(ins2[0]);
      });
    }
  }).then(function () {
    document.querySelectorAll('#customerForm [data-f]').forEach(function (inp) { inp.value = ''; });
    renderAll();
  }).catch(function (e) { alert('保存失败：' + e.message); });
}

// ---------- 项目与订单：新建 ----------
// 订单与客户的关联只按公司名精确匹配（与导入脚本同一规则）；匹配不上留空，不推断。
function setOrderStatus(msg, isError) {
  var el = $('orderStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}
function addOrder() {
  var fields = {};
  document.querySelectorAll('#orderForm [data-f]').forEach(function (inp) { fields[inp.dataset.f] = inp.value.trim(); });
  if (!fields.order_no || !fields.title) { alert('请至少填写订单编号和项目 / 产品'); return; }
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var numOrNull = function (v) { return v === '' ? null : parseFloat(v); };
  var row = {
    order_no: fields.order_no, title: fields.title,
    order_date: fields.order_date || null,
    stage: fields.stage || '打样',
    customer_company: fields.customer_company || '',
    customer_contact: fields.customer_contact || '',
    amount_usd: numOrNull(fields.amount_usd),
    received_usd: numOrNull(fields.received_usd),
    exchange_rate: numOrNull(fields.exchange_rate),
    cost_rmb: numOrNull(fields.cost_rmb),
    cost_note: fields.cost_note || '',
    profit_rmb: numOrNull(fields.profit_rmb),
    profit_rate: numOrNull(fields.profit_rate),
    profit_status: fields.profit_status || '待确认',
    customer_id: null
  };
  var match = null;
  state.customers.forEach(function (c) {
    if (!match && String(c.company || '').trim() &&
        String(c.company || '').trim() === String(row.customer_company).trim()) match = c;
  });
  if (match) row.customer_id = match.id;
  setOrderStatus('正在保存……');
  sbInsert('followup_orders', row).then(function (inserted) {
    var fresh = inserted && inserted[0] ? inserted[0] : row;
    state.orders.unshift(fresh);
    document.querySelectorAll('#orderForm [data-f]').forEach(function (inp) {
      if (inp.tagName === 'SELECT') {
        if (inp.dataset.f === 'profit_status') inp.value = '待确认';
        else if (inp.options.length) inp.value = inp.options[0].value;
      } else inp.value = '';
    });
    setOrderStatus('已添加订单 ' + row.order_no + '。');
    renderAll();
  }).catch(function (e) { setOrderStatus('保存失败：' + e.message, true); });
}

// ---------- 供应商与物流：新建 ----------
// 空字段存空字符串，不编造“待补充”写进库；显示时按旧站占位渲染（见 renderSuppliers）。
function setSupplierStatus(msg, isError) {
  var el = $('supplierStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}
function addSupplier() {
  var fields = {};
  document.querySelectorAll('#supplierForm [data-f]').forEach(function (inp) { fields[inp.dataset.f] = inp.value.trim(); });
  if (!fields.name) { alert('请填写伙伴名称'); return; }
  if (!hasKey) { alert('未配置 Supabase key，无法保存'); return; }
  var row = {
    name: fields.name, kind: fields.kind || '供应商',
    contact: fields.contact || '', contact_info: fields.contact_info || '',
    service_or_route: fields.service_or_route || '', detail_count: 0
  };
  setSupplierStatus('正在保存……');
  sbInsert('followup_suppliers', row).then(function (inserted) {
    var fresh = inserted && inserted[0] ? inserted[0] : row;
    state.suppliers.unshift(fresh);
    document.querySelectorAll('#supplierForm [data-f]').forEach(function (inp) {
      if (inp.tagName === 'SELECT') inp.value = '供应商';
      else inp.value = '';
    });
    setSupplierStatus('已添加伙伴 ' + row.name + '。');
    renderAll();
  }).catch(function (e) { setSupplierStatus('保存失败：' + e.message, true); });
}

// ---------- v3：导出 CSV（当前筛选结果，全部字段，每日上限） ----------
// 导出的是当前跟进清单的筛选结果（筛选 + 搜索都生效），一行一条询盘；
// 没有询盘的客户也各占一行（询盘字段留空），所以导出的客户不会丢。
// 字段是全部字段，不只是页面上看得见的列：档案编号、验证状态、标签、开发/已读计数、
// 等级、产品、规格、阶段、回复状态、最近回复、下一步、下次跟进日期等都在内。
// 每日上限 EXPORT_DAILY_CAP（默认 50,000 行/天），计数存在浏览器 localStorage，按天归零；
// 超限时直接拦截并提示，不导出。
function exportRows() {
  var rows = filteredInquiries();
  var byId = {};
  state.customers.forEach(function (c) { byId[c.id] = c; });
  var out = rows.map(function (r) {
    var c = r.cust || {};
    return { customer: c, inquiry: r.inq };
  });
  // 没有询盘的客户：补一行，询盘字段留空
  var withInquiry = {};
  state.inquiries.forEach(function (inq) { withInquiry[inq.customer_id] = true; });
  state.customers.forEach(function (c) {
    if (!withInquiry[c.id]) out.push({ customer: c, inquiry: null });
  });
  return out;
}
function csvEscape(v) {
  var s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function buildExportCsv(pairs) {
  var headers = ['客户档案编号', '客户姓名', '公司', '邮箱', '邮箱验证状态', '标签', '国家', '职位',
    '官网', '电话', 'WhatsApp', '客户类型', '客户来源', '等级', '发出计数', '已读计数',
    '健康度', '最后联系', '客户下次跟进', '客户下一步',
    '询盘编号', '产品类别', '产品需求', '规格', '当前阶段', '客户回复状态', '最近回复',
    '询盘日期', '最近联系日期', '下次跟进日期', '日期已手动确认', '询盘下一步', '询盘备注'];
  var lines = [headers.map(csvEscape).join(',')];
  pairs.forEach(function (p) {
    var c = p.customer || {}, q = p.inquiry || {};
    lines.push([
      c.profile_no, c.name, c.company, c.email, c.verification_status || 'unverified',
      tagsToString(c.tags), c.country, c.job_title, c.website, c.phone, c.whatsapp,
      c.customer_type, c.source, c.grade, c.outreach_count || 0, c.read_count || 0,
      c.health_score, c.last_contact_at, c.next_followup_at, c.next_action,
      q.inquiry_no, q.product_category, q.product, q.specs, q.stage, q.reply_status,
      q.reply_snippet, q.inquiry_date, q.last_contact_at, q.next_followup_at,
      q.next_followup_confirmed, q.next_action, q.notes
    ].map(csvEscape).join(','));
  });
  return '\ufeff' + lines.join('\r\n');
}
function exportCsv() {
  var pairs = exportRows();
  var key = exportCountKey();
  var used = parseInt((typeof localStorage !== 'undefined' && localStorage.getItem(key)) || '0', 10) || 0;
  var check = checkExportCap(used, pairs.length, EXPORT_DAILY_CAP);
  if (!check.ok) {
    var msg = '今日导出已达上限：上限 ' + EXPORT_DAILY_CAP + ' 行/天，今日已导出 ' + used + ' 行，本次要导 ' + pairs.length + ' 行。明天再导，或收窄筛选后再导出。';
    setStatus(msg, true);
    alert(msg);
    return;
  }
  var csv = buildExportCsv(pairs);
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'followup-export-' + todayStr() + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  try { localStorage.setItem(key, String(used + pairs.length)); } catch (e) { /* 隐私模式下计数写不进，不影响导出 */ }
  setStatus('已导出 ' + pairs.length + ' 行（CSV，全部字段）。今日已用 ' + (used + pairs.length) + ' / ' + EXPORT_DAILY_CAP + ' 行。');
}

// ---------- 邮箱同步（手动按钮；真正同步在 Vercel 后台函数里做） ----------
function syncEmail() {
  var btn = $('syncBtn');
  btn.disabled = true;
  btn.textContent = '同步中……';
  $('syncStatus').textContent = '正在连接邮箱同步服务……';
  // 服务端 240 秒主动截止返回；前端 280 秒兜底，超时就放开按钮并提示，
  // 绝不一直卡在“同步中……”上（2026-11-16 旧版曾卡 4 分钟无响应）。
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 280000);
  fetch('/api/sync-email', { method: 'POST', signal: ctrl.signal })
    .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); })
    .then(function (r) {
      if (r.ok) {
        var s = r.body || {};
        lastSyncSummaryText = '上次同步：' + new Date().toLocaleString('zh-CN') +
          '，拉取 ' + (s.fetched || 0) + ' 封，新增 ' + (s.new || 0) + ' 封，匹配到客户 ' +
          (s.matched || 0) + ' 封，待判断 ' + (s.needs_review || 0) + ' 封' +
          '，自动停待办 ' + (s.auto_stopped || 0) + ' 条，建待办 ' + (s.todos_created || 0) + ' 条' +
          ((s.errors && s.errors.length) ? '。（提示：' + s.errors.join('；') + '）' : '。');
        $('syncStatus').textContent = lastSyncSummaryText;
        setStatus('邮箱同步完成，正在刷新列表……');
        loadAll();
      } else {
        // 优先显示 message（具体原因，如“拉取 INBOX 正文超时”），而不是 error 代码 sync_failed
        var msg = (r.body && (r.body.message || r.body.error)) || ('同步服务返回 HTTP ' + r.status);
        $('syncStatus').textContent = '邮箱未连接：' + msg + '（请在 Vercel 环境变量配置 IMAP：IMAP_HOST=imap.yunyou.top，IMAP_USER=kevin@neoprenecustom.com）';
        setStatus('邮箱同步未完成：' + msg, true);
      }
    })
    .catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        // 服务端超过 280 秒未返回：可能邮箱里新邮件太多，本轮没跑完。
        // 服务端会在 240 秒时主动返回部分结果；这次没等到，刷新页面看“上次同步”是否已更新，
        // 没更新就再点一次同步（已入库的邮件不会重复）。
        $('syncStatus').textContent = '同步超时：服务器 280 秒未返回，请刷新页面查看“上次同步”是否已更新，没更新就再点一次同步。';
        setStatus('同步超时（服务器未在 280 秒内返回）。已入库的邮件不会重复，再点一次同步会继续处理剩下的。', true);
        return;
      }
      // 本地用 file:// 打开或未部署时，/api/sync-email 根本不存在，走这条分支是正常的。
      $('syncStatus').textContent = '邮箱未连接：请在 Vercel 环境变量配置 IMAP（IMAP_HOST=imap.yunyou.top，IMAP_USER=kevin@neoprenecustom.com），部署后点“同步邮箱”才生效。';
      setStatus('同步接口不可用（本地预览时正常，部署到 Vercel 后才生效）。', true);
    })
    .finally(function () { clearTimeout(timer); btn.disabled = false; btn.textContent = '🔄 同步邮箱'; });
}

// ---------- 加载 ----------
function loadAll() {
  selectedCustomerIds = {}; // 重新加载后旧的勾选作废，避免删到已不存在的客户
  if (!hasKey) {
    state.customers = []; state.inquiries = []; state.emails = [];
    state.orders = []; state.suppliers = []; state.history = [];
    state.prospects = []; state.prospectBatches = []; state.prospectContacts = []; state.prospectCoverage = [];
    setStatus('未配置 Supabase anon key：请复制 config.example.js 为 config.js 并填入真实 key，导入真实数据后这里会显示 216 位客户 / 201 条询盘。');
    renderAll();
    return;
  }
  setStatus('正在从 Supabase 加载客户、询盘、订单与邮件……');
  Promise.all([
    sbList('followup_customers', 'updated_at.desc').catch(function (e) { throw new Error('客户档案：' + e.message); }),
    sbList('followup_inquiries', 'created_at.desc').catch(function (e) { throw new Error('询盘：' + e.message); }),
    sbList('followup_emails', 'sent_at.desc').catch(function (e) { throw new Error('邮件：' + e.message); }),
    // 注意：followup_sync_state 表没有 created_at 列，不能用默认排序，改按 updated_at
    sbList('followup_sync_state', 'updated_at.desc').catch(function () { return []; }),
    sbList('followup_orders', 'created_at.desc').catch(function (e) { throw new Error('项目与订单：' + e.message); }),
    sbList('followup_suppliers', 'created_at.desc').catch(function (e) { throw new Error('供应商与物流：' + e.message); }),
    // 跟进历史 310 行：经营汇总的“首次进入已成交”按它推导；PostgREST 默认上限 1000 行，一次够
    sbList('followup_history', 'created_at.desc').catch(function (e) { throw new Error('跟进历史：' + e.message); }),
    // 搜客池 Phase 1（4 张表；SQL 先行：表不存在时这里会报加载失败，见 supabase-prospect-pool.sql 头注）
    sbList('prospect_batches', 'created_at.desc').catch(function (e) { throw new Error('搜客批次：' + e.message); }),
    // 候选按分数倒序（PostgREST 默认上限 1000 行；先看高分，够复核用）
    sb('prospect_candidates', { query: 'select=*&order=score_total.desc.nullslast,created_at.desc' }).catch(function (e) { throw new Error('搜客池：' + e.message); }),
    sbList('prospect_contacts', 'created_at.desc').catch(function (e) { throw new Error('候选联系人：' + e.message); }),
    sbList('prospect_coverage', 'created_at.desc').catch(function (e) { throw new Error('覆盖记忆：' + e.message); })
  ]).then(function (results) {
    state.customers = results[0] || [];
    state.inquiries = results[1] || [];
    state.emails = results[2] || [];
    state.syncState = (results[3] && results[3][0]) || null;
    state.orders = results[4] || [];
    state.suppliers = results[5] || [];
    state.history = results[6] || [];
    state.prospectBatches = results[7] || [];
    state.prospects = results[8] || [];
    state.prospectContacts = results[9] || [];
    state.prospectCoverage = results[10] || [];
    // 本次会话刚同步过：保留同步结果的完整数字，不被这里的“上次同步”一行盖掉
    // （旧版盖掉后页面上只剩一行，看不到拉取/新增/匹配/待判断的分项数字）。
    if (lastSyncSummaryText) { $('syncStatus').textContent = lastSyncSummaryText; }
    else if (state.syncState && state.syncState.last_sync_at) {
      $('syncStatus').textContent = '上次同步：' + new Date(state.syncState.last_sync_at).toLocaleString('zh-CN') +
        (state.syncState.last_error ? '（上次同步有报错：' + state.syncState.last_error + '）' : '');
    }
    setStatus(''); // 加载完成后不留说明行；同步/导出等操作仍用这行短暂提示结果
    renderAll();
  }).catch(function (e) {
    // 任一表加载失败：只报错，不用假数据填充，避免把示例当成真实数据。
    setStatus('加载失败：' + e.message + '（请先在 Supabase SQL Editor 执行 supabase-followup.sql 建表，再按 README 第 5 步导入）', true);
    state.customers = []; state.inquiries = []; state.emails = [];
    state.orders = []; state.suppliers = []; state.history = [];
    state.prospects = []; state.prospectBatches = []; state.prospectContacts = []; state.prospectCoverage = [];
    renderAll();
    $('followList').innerHTML = '<div class="empty error-box">加载失败：' + esc(e.message) + '</div>';
  });
}

// ---------- 初始化 ----------
function init() {
  renderDate();
  $('sideNav').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]');
    if (!b) return;
    currentView = b.dataset.view;
    document.querySelectorAll('#sideNav .nav-item').forEach(function (x) { x.classList.toggle('active', x === b); });
    document.querySelectorAll('.tabpane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + currentView); });
  });
  $('filterTabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-filter]');
    if (!b) return;
    currentFilter = b.dataset.filter;
    document.querySelectorAll('#filterTabs .subtab').forEach(function (x) { x.classList.toggle('active', x === b); });
    renderFollowList();
  });
  $('searchBox').addEventListener('input', function () { searchText = $('searchBox').value.trim(); renderFollowList(); });
  $('searchAll').addEventListener('input', function () { allSearchText = $('searchAll').value.trim(); renderAllInquiries(); });
  // 项目与订单：类型 / 客户 / 阶段筛选 + 搜索 + 刷新 + 新建
  $('filterOrderType').addEventListener('change', function () { orderTypeFilter = $('filterOrderType').value; renderOrders(); });
  $('filterOrderCustomer').addEventListener('change', function () { orderCustomerFilter = $('filterOrderCustomer').value; renderOrders(); });
  $('filterOrderStage').addEventListener('change', function () { orderStageFilter = $('filterOrderStage').value; renderOrders(); });
  $('searchOrders').addEventListener('input', function () { orderSearchText = $('searchOrders').value.trim(); renderOrders(); });
  $('refreshOrdersBtn').addEventListener('click', loadAll);
  $('addOrderBtn').addEventListener('click', addOrder);
  $('addOrderBtnTop').addEventListener('click', function () {
    var f = $('orderForm');
    if (!f) return;
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var first = f.querySelector('[data-f="order_no"]');
    if (first) first.focus();
  });
  // 经营汇总：月份切换 + 刷新
  $('summaryMonth').addEventListener('change', function () { summaryMonth = $('summaryMonth').value; renderSummary(); });
  $('refreshSummaryBtn').addEventListener('click', loadAll);
  // 供应商与物流：搜索 + 类型筛选 + 刷新 + 新建
  $('searchSuppliers').addEventListener('input', function () { supplierSearchText = $('searchSuppliers').value.trim(); renderSuppliers(); });
  $('filterSupplierKind').addEventListener('change', function () { supplierKindFilter = $('filterSupplierKind').value; renderSuppliers(); });
  $('refreshSuppliersBtn').addEventListener('click', loadAll);
  $('addSupplierBtn').addEventListener('click', addSupplier);
  $('addSupplierBtnTop').addEventListener('click', function () {
    var f = $('supplierForm');
    if (!f) return;
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var first = f.querySelector('[data-f="name"]');
    if (first) first.focus();
  });
  $('searchCustomers').addEventListener('input', function () { customerSearchText = $('searchCustomers').value.trim(); renderCustomers(); });
  $('filterCustomerType').addEventListener('change', function () { customerTypeFilter = $('filterCustomerType').value; renderCustomers(); });
  $('filterCustomerGrade').addEventListener('change', function () { customerGradeFilter = $('filterCustomerGrade').value; renderCustomers(); });
  $('batchDeleteBtn').addEventListener('click', batchDeleteCustomers);
  $('importCustomersBtn').addEventListener('click', function () { $('importCustomersFile').click(); });
  $('importCustomersFile').addEventListener('change', function () { handleImportFile($('importCustomersFile').files[0]); });
  $('exportCustomersBtn').addEventListener('click', exportCustomersExcel);
  $('refreshCustomersBtn').addEventListener('click', loadAll);
  // 搜客池：搜索 / 国家 / 分数段 / 状态 / 批次筛选 + 导入 + 刷新
  $('searchProspects').addEventListener('input', function () { prospectSearchText = $('searchProspects').value.trim(); renderProspects(); });
  $('filterProspectCountry').addEventListener('change', function () { prospectCountryFilter = $('filterProspectCountry').value; renderProspects(); });
  $('filterProspectBand').addEventListener('change', function () { prospectBandFilter = $('filterProspectBand').value; renderProspects(); });
  $('filterProspectStatus').addEventListener('change', function () { prospectStatusFilter = $('filterProspectStatus').value; renderProspects(); });
  $('filterProspectBatch').addEventListener('change', function () { prospectBatchFilter = $('filterProspectBatch').value; renderProspects(); });
  $('importProspectBtn').addEventListener('click', function () { $('importProspectFile').click(); });
  var prospectSearchBtn = $('prospectSearchBtn');
  if (prospectSearchBtn) prospectSearchBtn.addEventListener('click', handleProspectSearch);
  var prospectSearchKeyword = $('prospectSearchKeyword');
  if (prospectSearchKeyword) prospectSearchKeyword.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); handleProspectSearch(); } });
  $('importProspectFile').addEventListener('change', function () { handleProspectFile($('importProspectFile').files[0]); });
  $('refreshProspectsBtn').addEventListener('click', loadAll);
  // 表格复选框（事件委托；每点一次重渲染，勾选状态存在 selectedCustomerIds 里，不会丢）
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-select-all-customers')) {
      var rows = filteredCustomers();
      rows.forEach(function (c) {
        if (t.checked) selectedCustomerIds[String(c.id)] = true;
        else delete selectedCustomerIds[String(c.id)];
      });
      renderCustomers();
      return;
    }
    if (t.dataset.selectCustomer) {
      if (t.checked) selectedCustomerIds[t.dataset.selectCustomer] = true;
      else delete selectedCustomerIds[t.dataset.selectCustomer];
      renderCustomers();
    }
  });
  $('syncBtn').addEventListener('click', syncEmail);
  $('exportBtn').addEventListener('click', exportCsv);
  $('refreshBtn').addEventListener('click', loadAll);
  $('addCustomerBtn').addEventListener('click', addCustomer);
  document.addEventListener('click', function (e) {
    var t = e.target;
    // 订单行点客户名称：只看该客户的项目与订单；再点一次取消筛选
    if (t.dataset.filterOrderCustomer) {
      var co = t.dataset.filterOrderCustomer;
      orderCustomerFilter = (orderCustomerFilter === co) ? '' : co;
      var sel = $('filterOrderCustomer');
      if (sel) sel.value = orderCustomerFilter;
      renderOrders();
      return;
    }
    if (t.dataset.editInquiry) { editingId = t.dataset.editInquiry; renderAll(); return; }
    if (t.dataset.saveInquiry) { saveInquiry(t.dataset.saveInquiry); return; }
    if (t.dataset.replyInquiry) { replyingTo = { inquiryId: t.dataset.replyInquiry, emailId: '' }; replyDraft = null; renderAll(); return; }
    if (t.dataset.replyEmail) {
      var em = null;
      state.emails.forEach(function (e) { if (String(e.id) === String(t.dataset.replyEmail)) em = e; });
      if (em && em.inquiry_id) { replyingTo = { inquiryId: em.inquiry_id, emailId: em.id }; replyDraft = null; renderAll(); }
      else alert('这封邮件没有关联的询盘，无法回复');
      return;
    }
    if (t.hasAttribute('data-send-reply')) { var box = t.closest('[data-reply-box]'); if (box) sendReply(box); return; }
    if (t.hasAttribute('data-confirm-send')) { var box2 = t.closest('[data-reply-box]'); if (box2) doSendReply(box2); return; }
    if (t.hasAttribute('data-back-to-edit')) { if (replyDraft) replyDraft.confirming = false; renderAll(); return; }
    if (t.hasAttribute('data-cancel-reply')) { replyingTo = null; replyDraft = null; renderAll(); return; }
    if (t.dataset.convertProspect) { convertProspectToCustomer(t.dataset.convertProspect); return; }
    if (t.dataset.discardProspect) { discardProspect(t.dataset.discardProspect); return; }
    if (t.hasAttribute('data-confirm-prospect-import')) { confirmProspectImport(); return; }
    if (t.hasAttribute('data-cancel-prospect-import')) {
      pendingProspectImport = null; renderProspectImportPreview(); setProspectStatus('已取消导入。');
      return;
    }
    if (t.dataset.cancelEdit) { editingId = null; renderAll(); return; }
    if (t.dataset.confirmInquiryReview) {
      var card = t.closest('.review-card');
      if (card) confirmInquiryReview(t.dataset.confirmInquiryReview, card);
      return;
    }
    if (t.dataset.confirmReview) {
      var card2 = t.closest('.review-card');
      if (card2) confirmReview(t.dataset.confirmReview, card2);
      return;
    }
    if (t.hasAttribute('data-toggle-body')) {
      var body = t.closest('.review-card').querySelector('[data-body]');
      if (body) body.classList.toggle('hidden');
    }
  });
  loadAll();
}

if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

// Node 下测试用（浏览器里 module 不存在，不执行）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeInquiryStatus: computeInquiryStatus,
    computeCards: computeCards,
    buildTodos: buildTodos,
    daysBetween: daysBetween,
    addDays: addDays,
    isTerminalStage: isTerminalStage,
    OVERDUE_DAYS: OVERDUE_DAYS,
    FOLLOWUP_DELAY_DAYS: FOLLOWUP_DELAY_DAYS,
    // v3 LaiFaXin 做法（单测用）
    DEFAULT_TODO_DAYS: DEFAULT_TODO_DAYS,
    EXPORT_DAILY_CAP: EXPORT_DAILY_CAP,
    findDuplicateCustomer: findDuplicateCustomer,
    normalizeTags: normalizeTags,
    tagsToString: tagsToString,
    checkExportCap: checkExportCap,
    emailDomain: emailDomain,
    isFreeDomain: isFreeDomain,
    verificationLabel: verificationLabel,
    // 项目与订单 / 经营汇总（单测用）
    isConfirmedOrder: isConfirmedOrder,
    isCancelledOrder: isCancelledOrder,
    orderTypeOf: orderTypeOf,
    orderCny: orderCny,
    round2: round2,
    beijingDate: beijingDate,
    firstClosedDateByInquiry: firstClosedDateByInquiry,
    computeMonthlySummary: computeMonthlySummary,
    fmtUSD: fmtUSD,
    fmtCNY: fmtCNY,
    orderProfitCell: orderProfitCell,
    // 搜客池 Phase 1（单测用）
    SCORE_PRIORITY_MIN: SCORE_PRIORITY_MIN,
    SCORE_REVIEW_MIN: SCORE_REVIEW_MIN,
    SCORE_DISCARD_MAX: SCORE_DISCARD_MAX,
    normalizeDomain: normalizeDomain,
    normalizeCompanyName: normalizeCompanyName,
    parseProspectSize: parseProspectSize,
    checkProspectHardRules: checkProspectHardRules,
    detectProspectSignals: detectProspectSignals,
    scoreProspect: scoreProspect,
    scoreBand: scoreBand,
    classifyProspect: classifyProspect,
    findProspectDuplicate: findProspectDuplicate,
    detectProspectColumns: detectProspectColumns,
    normalizeProspectRow: normalizeProspectRow,
    processProspectImport: processProspectImport,
    buildProspectCandidate: buildProspectCandidate,
    findProspectCoverageHit: findProspectCoverageHit,
  // 搜客池 Phase 2（单测用）
  PROSPECT_SEARCH_MAX_RESULTS: PROSPECT_SEARCH_MAX_RESULTS,
  PROSPECT_SEARCH_SUGGESTIONS: PROSPECT_SEARCH_SUGGESTIONS,
  prospectSearchImportMeta: prospectSearchImportMeta,
  normalizeProspectSearchCompanies: normalizeProspectSearchCompanies,
  handleProspectSearch: handleProspectSearch
  };
}
