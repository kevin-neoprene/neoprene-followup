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

var state = { customers: [], inquiries: [], emails: [], syncState: null, orders: [], suppliers: [], history: [] };
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
  // 空态：未导入真实数据时显示导入提示条
  var empty = state.customers.length === 0 && state.inquiries.length === 0;
  $('importBanner').classList.toggle('hidden', !empty);
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
      '<button class="small ghost" data-cancel-edit="1">取消</button></div></td></tr>';
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
// SheetJS 只在第一次点导入/导出时才从 CDN 懒加载；页面本身不挂任何外部 JS，
// CDN 挂了也不影响页面打开。导入 .csv 不需要 SheetJS，始终可用。
var sheetJsPromise = null;
function loadSheetJS() {
  if (typeof window !== 'undefined' && window.XLSX) return Promise.resolve(window.XLSX);
  if (sheetJsPromise) return sheetJsPromise;
  sheetJsPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
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
// 不受下方搜索与筛选影响。CDN 失败时退回下载同名字段的 CSV，并明说。
function exportCustomersExcel() {
  setCustomerStatus('正在准备导出全部客户……');
  loadSheetJS().then(function (XLSX) {
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
  }).catch(function () {
    var csv = buildExportCsv(allCustomerExportPairs());
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '客户档案-' + todayStr() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    setCustomerStatus('表格组件未能从 CDN 加载，已改为导出 CSV（全部 ' + state.customers.length + ' 位客户，字段相同），请检查下载。', true);
  });
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
      '<button class="small" data-confirm-inquiry-review="' + esc(inq.id) + '">确认并标记已处理</button></div></div>';
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
      '<button class="small ghost" data-toggle-body>查看原文</button></div></div>';
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
    sbList('followup_history', 'created_at.desc').catch(function (e) { throw new Error('跟进历史：' + e.message); })
  ]).then(function (results) {
    state.customers = results[0] || [];
    state.inquiries = results[1] || [];
    state.emails = results[2] || [];
    state.syncState = (results[3] && results[3][0]) || null;
    state.orders = results[4] || [];
    state.suppliers = results[5] || [];
    state.history = results[6] || [];
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
    orderProfitCell: orderProfitCell
  };
}
