// POST /api/send-email — 在系统内给客户回邮件（Vercel Serverless Function）
// 邮箱：yunyou.top（西部数码云邮），SMTP smtp.yunyou.top:465 SSL。
// 账号密码复用 Vercel 里现有的 IMAP_USER / IMAP_PASS（云邮 SMTP 就是登录密码）。
// 密码绝不写进代码、绝不打印日志、绝不返回给前端：只从环境变量读。
//
// 环境变量（Vercel 项目设置里填，都是同步功能已在用的，无需新增）：
//   IMAP_USER=kevin@neoprenecustom.com   IMAP_PASS=<登录密码，仅存 Vercel，不进仓库>
//   SUPABASE_URL=https://gplkvdodbfzknyafdttb.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<service_role key，仅服务端用，绝不用 anon key 代替写操作>
//   SMTP_HOST=smtp.yunyou.top            （可选，默认 smtp.yunyou.top）
//   SMTP_PORT=465                        （可选，默认 465）
//
// 依赖：nodemailer（见 package.json，部署时 npm install）。
//
// 安全：只在用户在页面上点“发送”时才发，绝不自动发；一次只发给一个收件人，
// 不做群发（群发走来发信）；收件人必须在服务端核对过——是该询盘客户档案里的
// 邮箱、该询盘往来邮件的发件人，或用户自己的邮箱（自测），否则拒绝。
// 发件人固定是 IMAP_USER（kevin@neoprenecustom.com）。
//
// 请求 JSON：{ inquiryId, to, subject, body, nextFollowupAt?, emailId? }
//   inquiryId      询盘 id（必填）
//   to             收件人（必填，单个邮箱地址）
//   subject        主题（必填）
//   body           正文，纯文本（必填）
//   nextFollowupAt 下次跟进日期 YYYY-MM-DD（可选；不填默认今天 +3 天）
//   emailId        正在回复的那封原邮件 id（可选；用于 thread 和标记已处理）
//
// 发完服务端做：
//   1. 发 SMTP（原邮件有 Message-ID 时带 In-Reply-To / References，
//      让它在 Foxmail 和对方邮箱里落在同一封 thread 里）
//   2. 询盘 reply_status → '未回复 · 等待客户'，next_followup_at = 给的日期，
//      next_followup_confirmed = true，next_action = '已发邮件，等客户回复'
//   3. 跟进历史记一行 record_type '发邮件'
//   4. 按 v3 规则建一条待办（到期 = 下次跟进日期，指纹 sync-out|询盘|日期；
//      同步归档时指纹冲突跳过，不会重复建）
//   5. 原邮件（emailId）标记 needs_review = false（已回复即已处理）
//   不插 followup_emails：发出的信下次同步时从已发件里拉回来归档，沿用现有
//   规则（只把下次跟进往后推，不往前改；outreach_count 由同步归档时记）。
//
// 返回 JSON：{ ok: true, messageId, reply_status, next_followup_at, todoCreated }
//   失败：{ ok: false, error: '...' }，HTTP 400（校验）或 500（发送/写库失败）。
//   邮件已发出、但写库失败时：{ ok: false, sent: true, messageId, error: '...' }，
//   前端要把这句原样告诉用户，不要只说“发送失败”。

'use strict';

// ---------- Supabase REST（服务端用 service_role key；与 api/sync-email.js 同一写法） ----------
function makeSb(baseUrl, serviceKey) {
  function call(table, opts) {
    opts = opts || {};
    var url = baseUrl + '/rest/v1/' + table;
    if (opts.query) url += '?' + opts.query;
    if (opts.id) url += '?id=eq.' + encodeURIComponent(opts.id);
    return fetch(url, {
      method: opts.method || 'GET',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('Supabase ' + table + ' HTTP ' + res.status + ' ' + t.slice(0, 200)); });
      return res.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }
  return {
    list: function (table, query) { return call(table, { query: query || 'select=*' }); },
    insert: function (table, row) { return call(table, { method: 'POST', body: row }); },
    update: function (table, id, patch) { return call(table, { method: 'PATCH', id: id, body: patch }); }
  };
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function isEmail(s) {
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(String(s || '').trim());
}

function addDaysStr(dateStr, n) {
  var d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: '只接受 POST' });
  }
  var nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return json(res, 501, { ok: false, error: '邮件发送组件未安装（nodemailer），请部署后重试' });
  }
  var sender = process.env.IMAP_USER || 'kevin@neoprenecustom.com';
  var pass = process.env.IMAP_PASS || '';
  var sbUrl = process.env.SUPABASE_URL || 'https://gplkvdodbfzknyafdttb.supabase.co';
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!pass) {
    return json(res, 500, { ok: false, error: '邮箱未连接：请在 Vercel 环境变量配置 IMAP_PASS' });
  }
  if (!serviceKey) {
    return json(res, 500, { ok: false, error: '邮箱未连接：请在 Vercel 环境变量配置 SUPABASE_SERVICE_ROLE_KEY（服务端写库用，绝不要用 anon key）。' });
  }
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
  }
  body = body || {};
  var inquiryId = String(body.inquiryId || '').trim();
  var to = String(body.to || '').trim();
  var subject = String(body.subject || '').trim();
  var text = String(body.body || '');
  var emailId = String(body.emailId || '').trim();
  if (!inquiryId) return json(res, 400, { ok: false, error: '缺少询盘' });
  if (!isEmail(to)) return json(res, 400, { ok: false, error: '收件人不是单个有效的邮箱地址（一次只发给一个客户，不做群发）' });
  if (!subject) return json(res, 400, { ok: false, error: '请填写主题' });
  if (subject.length > 500) return json(res, 400, { ok: false, error: '主题太长（最多 500 字）' });
  if (!text.trim()) return json(res, 400, { ok: false, error: '请填写正文' });
  if (text.length > 20000) return json(res, 400, { ok: false, error: '正文太长（最多 20000 字）' });
  var today = new Date().toISOString().slice(0, 10);
  var nextFollowupAt = String(body.nextFollowupAt || '').trim();
  if (!nextFollowupAt) {
    nextFollowupAt = addDaysStr(today, 3);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(nextFollowupAt) || isNaN(Date.parse(nextFollowupAt))) {
    return json(res, 400, { ok: false, error: '下次跟进日期格式不对（应为 YYYY-MM-DD）' });
  }

  var sb = makeSb(sbUrl, serviceKey);
  // 1. 读询盘 + 客户，核对收件人
  var inqRows, customer;
  try {
    inqRows = await sb.list('followup_inquiries',
      'select=id,customer_id,inquiry_no,product&id=eq.' + encodeURIComponent(inquiryId) + '&limit=1');
  } catch (e) {
    return json(res, 500, { ok: false, error: '读询盘失败：' + e.message });
  }
  var inq = (inqRows && inqRows[0]) || null;
  if (!inq) return json(res, 400, { ok: false, error: '询盘不存在' });
  try {
    var custRows = await sb.list('followup_customers',
      'select=id,email,name,company&id=eq.' + encodeURIComponent(inq.customer_id) + '&limit=1');
    customer = (custRows && custRows[0]) || null;
  } catch (e) {
    return json(res, 500, { ok: false, error: '读客户失败：' + e.message });
  }
  // 2. 读该询盘的往来邮件：核对收件人 + 取 thread（优先用正在回复的那封）
  var threadMsgId = '', threadRefs = '', origEmail = null;
  var inbound = [];
  try {
    inbound = await sb.list('followup_emails',
      'select=id,from_email,message_id,refs,sent_at&inquiry_id=eq.' + encodeURIComponent(inquiryId) +
      '&direction=eq.in&order=sent_at.desc&limit=20') || [];
  } catch (e) {
    return json(res, 500, { ok: false, error: '读往来邮件失败：' + e.message });
  }
  if (emailId) {
    inbound.forEach(function (m) { if (String(m.id) === String(emailId)) origEmail = m; });
    if (!origEmail) return json(res, 400, { ok: false, error: '原邮件不存在，或不属于这条询盘' });
  }
  var threadSource = origEmail || null;
  if (!threadSource) {
    for (var i = 0; i < inbound.length; i++) {
      if (inbound[i].message_id) { threadSource = inbound[i]; break; }
    }
  }
  if (threadSource && threadSource.message_id) {
    threadMsgId = threadSource.message_id;
    threadRefs = String(threadSource.refs || '') + ' ' + threadMsgId;
    threadRefs = threadRefs.trim();
  }
  var allowed = {};
  if (customer && customer.email) allowed[String(customer.email).toLowerCase()] = true;
  allowed[sender.toLowerCase()] = true; // 给自己发（自测）始终允许
  inbound.forEach(function (m) { if (m.from_email) allowed[String(m.from_email).toLowerCase()] = true; });
  if (!allowed[to.toLowerCase()]) {
    return json(res, 400, { ok: false, error: '收件人不在这条询盘的往来邮箱里（客户档案邮箱 / 原邮件发件人 / 自己邮箱），请核对后再发' });
  }

  // 3. 发 SMTP
  var host = process.env.SMTP_HOST || 'smtp.yunyou.top';
  var port = parseInt(process.env.SMTP_PORT || '465', 10);
  var transporter = nodemailer.createTransport({
    host: host,
    port: port,
    secure: port === 465,
    auth: { user: sender, pass: pass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });
  var mail = { from: sender, to: to, subject: subject, text: text };
  if (threadMsgId) {
    mail.inReplyTo = threadMsgId;
    mail.references = threadRefs;
  }
  var info;
  try {
    info = await transporter.sendMail(mail);
  } catch (e) {
    // 绝不把密码写进日志或返回：nodemailer 的报错不含密码，只返回 message
    return json(res, 500, { ok: false, error: '发送失败：' + e.message });
  }
  console.log('send-email ok to=' + to + ' subject=' + subject + ' messageId=' + (info.messageId || ''));

  // 4. 发完写库：询盘状态 + 历史 + 待办 + 原邮件已处理
  var errors = [];
  try {
    await sb.update('followup_inquiries', inquiryId, {
      reply_status: '未回复 · 等待客户',
      next_followup_at: nextFollowupAt,
      next_followup_confirmed: true,
      next_action: '已发邮件，等客户回复',
      updated_at: new Date().toISOString()
    });
  } catch (e) { errors.push('询盘状态更新失败：' + e.message); }
  try {
    await sb.insert('followup_history', {
      customer_id: customer ? customer.id : null,
      inquiry_id: inquiryId,
      profile_no: '',
      inquiry_no: inq.inquiry_no || '',
      record_no: 'sent-' + inquiryId + '-' + Date.now(),
      record_type: '发邮件',
      content: '在系统内回复客户（' + to + '）：' + subject,
      recorded_at: new Date().toISOString()
    });
  } catch (e) { errors.push('跟进历史写入失败：' + e.message); }
  var todoCreated = false;
  try {
    await sb.insert('followup_todos', {
      customer_id: customer ? customer.id : null,
      inquiry_id: inquiryId,
      reason: '跟进邮件已发出：' + subject,
      next_action: '等客户回复；' + nextFollowupAt + ' 前未回再跟进一次',
      due_at: nextFollowupAt,
      done: false,
      stopped_by_reply: false,
      fingerprint: 'sync-out|' + inquiryId + '|' + nextFollowupAt
    });
    todoCreated = true;
  } catch (e) { /* 指纹冲突即已建过，跳过 */ }
  if (emailId) {
    try {
      await sb.update('followup_emails', emailId, { needs_review: false });
    } catch (e) { errors.push('原邮件标记失败：' + e.message); }
  }
  if (errors.length) {
    return json(res, 500, {
      ok: false, sent: true, messageId: info.messageId || '',
      error: '邮件已发出，但：' + errors.join('；')
    });
  }
  return json(res, 200, {
    ok: true,
    messageId: info.messageId || '',
    reply_status: '未回复 · 等待客户',
    next_followup_at: nextFollowupAt,
    todoCreated: todoCreated
  });
};
