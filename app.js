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

var state = { customers: [], inquiries: [], emails: [], syncState: null };
var currentView = 'workbench';
var currentFilter = 'all';
var searchText = '';
var customerSearchText = '';
var allSearchText = '';
var editingId = null; // 正在行内编辑的询盘 id

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
      '<button class="small ghost" data-cancel-edit>取消</button></div></td></tr>';
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

function renderCustomers() {
  var el = $('customerList');
  var rows = state.customers.slice();
  if (customerSearchText) {
    var q = customerSearchText.toLowerCase();
    rows = rows.filter(function (c) {
      return ((c.name || '') + ' ' + (c.company || '') + ' ' + (c.email || '') + ' ' + tagsToString(c.tags)).toLowerCase().indexOf(q) !== -1;
    });
  }
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无客户档案。' +
      (state.customers.length === 0 ? '请先按 README 第 5 步导入旧站导出文件（216 位客户）。' : '先在上面添加一位吧。') + '</div>';
    return;
  }
  el.innerHTML = '<table class="cust-table"><thead><tr><th>客户</th><th>公司 / 邮箱</th><th>国家 / 电话</th><th>等级</th><th>验证</th><th>标签</th><th>发出 / 已读</th><th>最后联系</th><th>下次跟进</th><th>下一步动作</th></tr></thead><tbody>' +
    rows.map(function (c) {
      var vs = c.verification_status || 'unverified';
      var tags = normalizeTags(c.tags);
      return '<tr><td><b>' + esc(c.name || '') + '</b></td>' +
        '<td>' + esc(c.company || '') + '<div class="c-sub">' + esc(c.email || '') + '</div></td>' +
        '<td>' + esc(c.country || '') + (c.phone ? '<div class="c-sub">' + esc(c.phone) + '</div>' : '') + '</td>' +
        '<td>' + esc(c.grade || '—') + '</td>' +
        // v3：邮箱验证状态徽章（只有 valid / unknown 以后可群发；群发在来发信里做）
        '<td><span class="badge v-' + esc(vs) + '">' + esc(verificationLabel(vs)) + '</span></td>' +
        '<td>' + (tags.length ? tags.map(function (t) { return '<span class="tag-chip">' + esc(t) + '</span>'; }).join(' ') : '<span class="c-sub">—</span>') + '</td>' +
        // v3：开发 / 阅读计数（发出一封 +1，收到一封匹配到的回复 +1）
        '<td>' + (parseInt(c.outreach_count, 10) || 0) + ' / ' + (parseInt(c.read_count, 10) || 0) + '</td>' +
        '<td>' + esc(fmtDate(c.last_contact_at)) + '</td>' +
        '<td>' + esc(fmtDate(c.next_followup_at)) + '</td>' +
        '<td>' + esc(c.next_action || c.eval_next_action || '—') + '</td></tr>';
    }).join('') + '</tbody></table>';
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

function renderAll() {
  renderCards();
  renderFollowList();
  renderAllInquiries();
  renderTodos();
  renderCustomers();
  renderReview();
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
  fetch('/api/sync-email', { method: 'POST' })
    .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); })
    .then(function (r) {
      if (r.ok) {
        var s = r.body || {};
        $('syncStatus').textContent = '上次同步：' + new Date().toLocaleString('zh-CN') +
          '，拉取 ' + (s.fetched || 0) + ' 封，新增 ' + (s.new || 0) + ' 封，匹配到客户 ' +
          (s.matched || 0) + ' 封，待判断 ' + (s.needs_review || 0) + ' 封。';
        setStatus('邮箱同步完成，正在刷新列表……');
        loadAll();
      } else {
        var msg = (r.body && (r.body.error || r.body.message)) || ('同步服务返回 HTTP ' + r.status);
        $('syncStatus').textContent = '邮箱未连接：' + msg + '（请在 Vercel 环境变量配置 IMAP：IMAP_HOST=imap.yunyou.top，IMAP_USER=kevin@neoprenecustom.com）';
        setStatus('邮箱同步未完成：' + msg, true);
      }
    })
    .catch(function () {
      // 本地用 file:// 打开或未部署时，/api/sync-email 根本不存在，走这条分支是正常的。
      $('syncStatus').textContent = '邮箱未连接：请在 Vercel 环境变量配置 IMAP（IMAP_HOST=imap.yunyou.top，IMAP_USER=kevin@neoprenecustom.com），部署后点“同步邮箱”才生效。';
      setStatus('同步接口不可用（本地预览时正常，部署到 Vercel 后才生效）。', true);
    })
    .finally(function () { btn.disabled = false; btn.textContent = '🔄 同步邮箱'; });
}

// ---------- 加载 ----------
function loadAll() {
  if (!hasKey) {
    state.customers = []; state.inquiries = []; state.emails = [];
    setStatus('未配置 Supabase anon key：请复制 config.example.js 为 config.js 并填入真实 key，导入真实数据后这里会显示 216 位客户 / 201 条询盘。');
    renderAll();
    return;
  }
  setStatus('正在从 Supabase 加载客户、询盘与邮件……');
  Promise.all([
    sbList('followup_customers', 'updated_at.desc').catch(function (e) { throw new Error('客户档案：' + e.message); }),
    sbList('followup_inquiries', 'created_at.desc').catch(function (e) { throw new Error('询盘：' + e.message); }),
    sbList('followup_emails', 'sent_at.desc').catch(function (e) { throw new Error('邮件：' + e.message); }),
    // 注意：followup_sync_state 表没有 created_at 列，不能用默认排序，改按 updated_at
    sbList('followup_sync_state', 'updated_at.desc').catch(function () { return []; })
  ]).then(function (results) {
    state.customers = results[0] || [];
    state.inquiries = results[1] || [];
    state.emails = results[2] || [];
    state.syncState = (results[3] && results[3][0]) || null;
    if (state.syncState && state.syncState.last_sync_at) {
      $('syncStatus').textContent = '上次同步：' + new Date(state.syncState.last_sync_at).toLocaleString('zh-CN') +
        (state.syncState.last_error ? '（上次同步有报错：' + state.syncState.last_error + '）' : '');
    }
    setStatus('数据保存在 Supabase，换设备打开也会同步。客户 ' + state.customers.length + ' 位，询盘 ' + state.inquiries.length + ' 条。');
    renderAll();
  }).catch(function (e) {
    // 任一表加载失败：只报错，不用假数据填充，避免把示例当成真实数据。
    setStatus('加载失败：' + e.message + '（请先在 Supabase SQL Editor 执行 supabase-followup.sql 建表，再按 README 第 5 步导入）', true);
    state.customers = []; state.inquiries = []; state.emails = [];
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
  $('searchCustomers').addEventListener('input', function () { customerSearchText = $('searchCustomers').value.trim(); renderCustomers(); });
  $('syncBtn').addEventListener('click', syncEmail);
  $('exportBtn').addEventListener('click', exportCsv);
  $('refreshBtn').addEventListener('click', loadAll);
  $('addCustomerBtn').addEventListener('click', addCustomer);
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset.editInquiry) { editingId = t.dataset.editInquiry; renderFollowList(); return; }
    if (t.dataset.saveInquiry) { saveInquiry(t.dataset.saveInquiry); return; }
    if (t.dataset.cancelEdit) { editingId = null; renderFollowList(); return; }
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
    verificationLabel: verificationLabel
  };
}
