// POST /api/sync-email — 邮箱同步（Vercel Serverless Function）
// 邮箱：yunyou.top（西部数码云邮），IMAP imap.yunyou.top:993 SSL，SMTP smtp.yunyou.top:465/587。
// IMAP 用邮箱登录密码（用户 2026-11-15 确认：没有单独的客户端授权码）。
// 密码绝不写进代码、绝不打印日志：只从环境变量 IMAP_PASS 读。
//
// 环境变量（Vercel 项目设置里填）：
//   IMAP_HOST=imap.yunyou.top            IMAP_PORT=993
//   IMAP_USER=kevin@neoprenecustom.com   IMAP_PASS=<登录密码，仅存 Vercel，不进仓库>
//   SUPABASE_URL=https://gplkvdodbfzknyafdttb.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<service_role key，仅服务端用，绝不用 anon key 代替写操作>
//   SYNC_DAYS=90                         （可选：每次往回扫多少天，默认 90）
//
// 依赖（见 package.json，部署时 npm install）：imap、mailparser。
// 本文件顶部不 require 它们：缺依赖时返回 501 + 明确提示，而不是部署即崩。
// 同步是只读的：IMAP 以只读方式开箱，不删、不移、不标已读；写操作只发生在自家 Supabase。
//
// 返回 JSON：{ fetched, new, matched, needs_review, auto_stopped, todos_created, errors }
//   fetched      本次从邮箱拉到的邮件数（含已在库里的）
//   new          本次新写入 followup_emails 的数（按 Message-ID 去重）
//   matched      新邮件里匹配到已有客户/询盘的数
//   needs_review 新邮件里 intent=auto_unknown、需人工判断的数
//   auto_stopped v3 回信自动停：客户一回信，自动停掉的未完成跟进待办条数
//   todos_created v3：你发出的跟进邮件，每封默认建一条 +3 天的待办（与前端写跟进一致）
//
// 2026-11-16 修：首次同步曾 300 秒超时（Vercel 日志：Task timed out after 300 seconds，
// 峰值内存 2162MB 超过 2048MB 上限）。原因是旧版一次拉取 90 天收件箱+已发件的全部
// 正文并全塞进内存。现改为“先拉信头、只拉新邮件正文、每轮最多处理 150 封、240 秒
// 截止返回部分结果”：信头小、去重在拉正文之前做，未处理完的下次同步继续（按
// Message-ID 去重，不会重复入库）。

'use strict';

// ---------- 保守分类：只有能确定的才自动定意向，其余一律 auto_unknown 进人工池 ----------
// 高置信度只给 4 种：bounce（退信）/ unsubscribe（退订）/ reject（明确拒绝）/ demand（明确下单）。
// “要报价 / 要样品 / 问价格”这类只做提示，不自动改状态 —— 见 README 的说明。
function classifyEmail(subject, body, fromAddress) {
  var from = String(fromAddress || '').toLowerCase();
  var text = String(subject || '') + '\n' + String(body || '');
  var low = text.toLowerCase();
  if (from.indexOf('mailer-daemon') !== -1 || from.indexOf('postmaster') !== -1 ||
      low.indexOf('delivery status notification') !== -1 ||
      low.indexOf('mail delivery failed') !== -1 ||
      low.indexOf('undeliverable') !== -1 ||
      low.indexOf('address not found') !== -1) {
    return { intent: 'bounce', confidence: 'high' };
  }
  if (/\bunsubscribe\b/.test(low) || low.indexOf('please remove me') !== -1 ||
      low.indexOf('stop sending me emails') !== -1) {
    return { intent: 'unsubscribe', confidence: 'high' };
  }
  if (low.indexOf('not interested') !== -1 || low.indexOf('no longer interested') !== -1 ||
      low.indexOf('do not contact') !== -1 || low.indexOf('please do not email') !== -1 ||
      low.indexOf('decided not to proceed') !== -1 ||
      low.indexOf('chosen another supplier') !== -1 ||
      low.indexOf('not proceed with') !== -1) {
    return { intent: 'reject', confidence: 'high' };
  }
  if (low.indexOf('confirm the order') !== -1 || low.indexOf('confirmed the order') !== -1 ||
      low.indexOf('proceed with the order') !== -1 ||
      low.indexOf('place an order') !== -1 ||
      low.indexOf('please send the proforma invoice') !== -1 ||
      low.indexOf('payment has been made') !== -1 ||
      low.indexOf('we have made the payment') !== -1) {
    return { intent: 'demand', confidence: 'high' };
  }
  return { intent: 'auto_unknown', confidence: 'low' };
}

function snippetOf(text, n) {
  var s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > (n || 200) ? s.slice(0, n || 200) + '…' : s;
}
function addrOf(parsedAddr) {
  // mailparser 的地址对象：{ text, value: [{ address, name }] }
  if (!parsedAddr) return '';
  if (typeof parsedAddr === 'string') return parsedAddr;
  if (parsedAddr.value && parsedAddr.value[0]) return parsedAddr.value[0].address || '';
  if (parsedAddr.address) return parsedAddr.address;
  return String(parsedAddr.text || '');
}
function nameOf(parsedAddr) {
  if (!parsedAddr || typeof parsedAddr === 'string') return '';
  if (parsedAddr.value && parsedAddr.value[0]) return parsedAddr.value[0].name || '';
  return '';
}
function imapDate(d) {
  // node-imap 的 SINCE 要 "DD-Mon-YYYY"，如 "17-Aug-2026"
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getDate() + '-' + months[d.getMonth()] + '-' + d.getFullYear();
}
function addDaysStr(dateStr, n) {
  var d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// 每轮最多处理的新邮件数（正文拉取 + 入库），超出的下次同步继续，不丢。
var MAX_NEW_PER_RUN = 150;
// 截止时间：Vercel 本项目上限 300 秒，240 秒时主动停下并返回已处理的部分结果，
// 绝不拖到平台强杀（强杀 = 前端什么都收不到）。
var SYNC_DEADLINE_MS = 240000;
// 单个 IMAP 拉取（信头或正文）超过这么久没完成就报错返回，不无限等。
var FETCH_TIMEOUT_MS = 60000;

// ---------- Supabase REST（服务端用 service_role key；不用浏览器 anon key） ----------
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
    update: function (table, id, patch) { return call(table, { method: 'PATCH', id: id, body: patch }); },
    // 按条件批量 PATCH（回信自动停用）：PATCH /rest/v1/<表>?<条件>，返回被改的行
    updateWhere: function (table, query, patch) {
      return fetch(baseUrl + '/rest/v1/' + table + '?' + query, {
        method: 'PATCH',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(patch)
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error('Supabase ' + table + ' HTTP ' + res.status + ' ' + t.slice(0, 200)); });
        return res.text().then(function (t) { return t ? JSON.parse(t) : []; });
      });
    },
    upsertSyncState: function (patch) {
      // followup_sync_state 只有 id=1 一行
      return call('followup_sync_state', { method: 'PATCH', id: 1, body: patch });
    }
  };
}

// ---------- IMAP：只读拉取 ----------
// 完成模型（2026-11-16 修）：一次 fetch 只有在“服务器流结束（end 事件）且所有
// 已到的邮件都处理完（pending 回 0）”时才算完成。旧版在 pending 回 0 时立刻
// resolve，服务器慢慢吐数据时会在中途提前返回——00:39 那次只拿到了 12 封信头，
// 而 00:31 那次拿到了 233 封，同一个邮箱同一窗口，纯属时序运气。
function collectFetch(fetch, onMessage, timeoutMs, label) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      finish(new Error('拉取' + label + '超时（' + (timeoutMs / 1000) + ' 秒无响应）'));
    }, timeoutMs);
    var done = false;
    var ended = false;
    var pending = 0;
    var out = [];
    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    }
    function maybeDone() {
      if (ended && pending === 0) finish(null, out);
    }
    fetch.on('message', function (msg) {
      pending++;
      onMessage(msg, function (item) {
        if (item) out.push(item);
        pending--;
        maybeDone();
      });
    });
    fetch.once('error', function (e) { finish(new Error('拉取' + label + '失败：' + e.message)); });
    fetch.once('end', function () { ended = true; maybeDone(); });
  });
}

// 先拉信头（HEADER.FIELDS）：只含 Message-ID / 日期 / 收发件人 / 主题 / In-Reply-To /
// References，体积小，用来做“哪些是新邮件”的去重，不下载正文。
// 返回 [{ uid, messageId, date, from, to, subject, inReplyTo, refs }]。
// UID 只能从 attributes 事件取（attrs.uid），msg.uid 不存在（00:35 的教训）。
function fetchHeaders(imap, simpleParser, boxName, sinceDate) {
  return new Promise(function (resolve, reject) {
    imap.openBox(boxName, true, function (err) {
      if (err) return reject(new Error('打不开邮箱文件夹 ' + boxName + '：' + err.message));
      imap.search([['SINCE', imapDate(sinceDate)]], function (err2, results) {
        if (err2) return reject(new Error('搜索 ' + boxName + ' 失败：' + err2.message));
        if (!results || !results.length) return resolve([]);
        var fetch = imap.fetch(results, {
          bodies: 'HEADER.FIELDS (MESSAGE-ID DATE FROM TO SUBJECT IN-REPLY-TO REFERENCES)',
          struct: false
        });
        collectFetch(fetch, function (msg, doneOne) {
          var raw = '';
          var uid = null;
          var parsedHeader = null;
          var bodyDone = false;
          var attrsDone = false;
          function maybePush() {
            if (!bodyDone || !attrsDone) return;
            doneOne(parsedHeader ? {
              uid: uid,
              messageId: parsedHeader.messageId,
              date: parsedHeader.date,
              from: parsedHeader.from,
              to: parsedHeader.to,
              subject: parsedHeader.subject,
              inReplyTo: parsedHeader.inReplyTo,
              refs: parsedHeader.refs
            } : null);
          }
          msg.once('attributes', function (attrs) { uid = attrs.uid; attrsDone = true; maybePush(); });
          msg.on('body', function (stream) {
            stream.on('data', function (chunk) { raw += chunk.toString('utf8'); });
            stream.once('end', function () {
              simpleParser(raw).then(function (parsed) {
                parsedHeader = {
                  messageId: String(parsed.messageId || '').trim(),
                  date: parsed.date ? new Date(parsed.date) : null,
                  from: addrOf(parsed.from),
                  to: parsed.to && parsed.to.value ? parsed.to.value.map(function (v) { return v.address || ''; }) : [],
                  subject: String(parsed.subject || ''),
                  inReplyTo: String(parsed.inReplyTo || ''),
                  refs: String(parsed.references || '')
                };
              }).catch(function () {
                // 信头解析失败的跳过：正文阶段不会再拉它，下次同步仍会重试
                parsedHeader = null;
              }).finally(function () { bodyDone = true; maybePush(); });
            });
          });
        }, FETCH_TIMEOUT_MS, boxName + ' 信头').then(resolve, reject);
      });
    });
  });
}

// 只拉指定 UID 的完整正文（已在信头阶段确认是新邮件的才拉，不浪费流量和内存）。
// 分小批拉（默认每批 10 封、每批 30 秒）：云邮拉大附件很慢，一封卡住不能拖垮整批；
// 超时或失败的整批跳过（计入 skipped，下次同步重试），继续拉下一批，不整体报错。
// isPastDeadline() 为真时停下不再拉新批次。返回 { mails, skipped }。
function fetchBodiesBatched(imap, simpleParser, boxName, uids, isPastDeadline) {
  var BATCH_SIZE = 10;
  var BATCH_TIMEOUT_MS = 30000;
  if (!uids || !uids.length) return Promise.resolve({ mails: [], skipped: 0 });
  return new Promise(function (resolve, reject) {
    imap.openBox(boxName, true, function (err) {
      if (err) return reject(new Error('打不开邮箱文件夹 ' + boxName + '：' + err.message));
      var mails = [];
      var skipped = 0;
      var i = 0;
      function nextBatch() {
        if (i >= uids.length) return resolve({ mails: mails, skipped: skipped });
        if (isPastDeadline && isPastDeadline()) {
          skipped += uids.length - i;
          return resolve({ mails: mails, skipped: skipped });
        }
        var chunk = uids.slice(i, i + BATCH_SIZE);
        i += chunk.length;
        var fetch = imap.fetch(chunk, { bodies: '', markSeen: false });
        collectFetch(fetch, function (msg, doneOne) {
          var raw = '';
          msg.on('body', function (stream) {
            stream.on('data', function (chunk2) { raw += chunk2.toString('utf8'); });
            stream.once('end', function () {
              simpleParser(raw).then(function (parsed) {
                doneOne(parsed);
              }).catch(function (e) {
                doneOne({ _parseError: e.message, _rawSnippet: raw.slice(0, 500) });
              });
            });
          });
        }, BATCH_TIMEOUT_MS, boxName + ' 正文').then(function (batchMails) {
          mails = mails.concat(batchMails);
          nextBatch();
        }, function () {
          // 整批超时/失败：跳过这批，继续下一批（这些邮件下次同步重试）
          skipped += chunk.length;
          nextBatch();
        });
      }
      nextBatch();
    });
  });
}

// 列出邮箱文件夹，找已发件的那个（名字各家不同：Sent / 已发送 / 发件箱 …）。
// 旧版逐个试 'Sent' / 'Sent Messages' / '已发送'，每个不存在的名字都耗满 60 秒
// 超时（00:39 那次 3 分钟悄无声息就是这么烧掉的）。找不到就返回 null，直接跳过已发件。
function findSentBox(imap) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(null); }, 10000);
    try {
      imap.getBoxes(function (err, boxes) {
        clearTimeout(timer);
        if (err || !boxes) return resolve(null);
        var names = [];
        (function walk(o) {
          Object.keys(o || {}).forEach(function (k) {
            names.push(k);
            if (o[k].children) walk(o[k].children);
          });
        })(boxes);
        var hit = null;
        for (var n = 0; n < names.length; n++) {
          if (/sent|已发送|发件/i.test(names[n])) { hit = names[n]; break; }
        }
        resolve(hit);
      });
    } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function connectImap(Imap, cfg) {
  return new Promise(function (resolve, reject) {
    var imap = new Imap({
      user: cfg.user,
      password: cfg.pass, // 只从环境变量来；此处绝不打印
      host: cfg.host,
      port: cfg.port,
      tls: true,
      tlsOptions: { rejectUnauthorized: true },
      // 云邮服务器响应慢（01:03 那次 10 秒认证超时）：放宽到 30 秒。
      connTimeout: 30000,
      authTimeout: 30000
    });
    imap.once('ready', function () { resolve(imap); });
    imap.once('error', function (err) { reject(new Error('IMAP 连接失败（' + cfg.host + ':' + cfg.port + '）：' + err.message + '。请检查 Vercel 环境变量与网页邮箱里 IMAP 是否已开启。')); });
    imap.connect();
  });
}

// 连不上就等 5 秒再试一次（服务器一时忙很常见；两次都失败才报错返回）。
async function connectImapWithRetry(Imap, cfg) {
  var lastErr = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var imap = await connectImap(Imap, cfg);
      if (attempt > 1) console.log('[sync] IMAP 第 ' + attempt + ' 次连接成功');
      return imap;
    } catch (e) {
      lastErr = e;
      console.log('[sync] IMAP 第 ' + attempt + ' 次连接失败：' + e.message);
      if (attempt < 2) await sleep(5000);
    }
  }
  throw lastErr;
}

// ---------- 主处理 ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: '请用 POST 调用 /api/sync-email' });
    return;
  }
  var host = process.env.IMAP_HOST || 'imap.yunyou.top';
  var port = parseInt(process.env.IMAP_PORT || '993', 10);
  var user = process.env.IMAP_USER || 'kevin@neoprenecustom.com';
  var pass = process.env.IMAP_PASS || '';
  var sbUrl = process.env.SUPABASE_URL || 'https://gplkvdodbfzknyafdttb.supabase.co';
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  var syncDays = parseInt(process.env.SYNC_DAYS || '90', 10);
  var startedAt = Date.now();
  function pastDeadline() { return Date.now() - startedAt > SYNC_DEADLINE_MS; }

  if (!pass) {
    res.status(501).json({
      error: 'email_not_configured',
      message: '邮箱未连接：请在 Vercel 环境变量配置 IMAP_PASS（云邮登录密码）。IMAP_HOST=' + host + '，IMAP_USER=' + user + '。'
    });
    return;
  }
  if (!serviceKey) {
    res.status(501).json({
      error: 'email_not_configured',
      message: '邮箱未连接：请在 Vercel 环境变量配置 SUPABASE_SERVICE_ROLE_KEY（服务端写库用，绝不要用 anon key）。'
    });
    return;
  }

  var Imap, simpleParser;
  try {
    Imap = require('imap'); // eslint-disable-line global-require
    simpleParser = require('mailparser').simpleParser; // eslint-disable-line global-require
  } catch (e) {
    res.status(501).json({
      error: 'missing_deps',
      message: '邮箱同步依赖未安装：请在项目根目录执行 npm install（依赖 imap、mailparser），再重新部署。'
    });
    return;
  }

  var sb = makeSb(sbUrl, serviceKey);
  var summary = { fetched: 0, new: 0, matched: 0, needs_review: 0, auto_stopped: 0, todos_created: 0, errors: [] };
  var imap = null;
  try {
    console.log('[sync] 开始：SYNC_DAYS=' + syncDays + '，上限 ' + MAX_NEW_PER_RUN + ' 封新邮件/轮，' +
      (SYNC_DEADLINE_MS / 1000) + ' 秒截止');
    // 1) 读库里已有的客户 / 邮件，建立匹配索引（v3：顺带读开发/已读计数，同步时 +1 用）
    var customers = await sb.list('followup_customers', 'select=id,name,company,email,outreach_count,read_count');
    var byEmail = {};
    customers.forEach(function (c) { if (c.email) byEmail[String(c.email).trim().toLowerCase()] = c; });
    var knownEmails = await sb.list('followup_emails', 'select=message_id,in_reply_to,refs,customer_id,inquiry_id,thread_id');
    var knownIds = {};
    var threadMap = {}; // message-id / in-reply-to / references token -> { customer_id, inquiry_id }
    knownEmails.forEach(function (e) {
      if (e.message_id) { knownIds[e.message_id] = true; threadMap[e.message_id] = e; }
      if (e.in_reply_to) threadMap[e.in_reply_to] = e;
      String(e.refs || '').split(/\s+/).forEach(function (tok) { if (tok) threadMap[tok] = e; });
    });
    console.log('[sync] 库里已有客户 ' + customers.length + ' 位、邮件 ' + knownEmails.length + ' 封');

    // 2) IMAP 只读拉取：先拉信头做去重，再只拉新邮件的正文。
    //    收件箱 + 已发件（文件夹名按服务商可能不同，逐个试）
    imap = await connectImapWithRetry(Imap, { user: user, pass: pass, host: host, port: port });
    console.log('[sync] IMAP 已连接 ' + host + ':' + port);
    var since = new Date();
    since.setDate(since.getDate() - syncDays);

    var inboxHeaders = await fetchHeaders(imap, simpleParser, 'INBOX', since);
    console.log('[sync] INBOX 信头 ' + inboxHeaders.length + ' 封');
    var inboxNew = inboxHeaders
      .filter(function (h) { return h.messageId && !knownIds[h.messageId]; })
      .sort(function (a, b) { return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0); });
    console.log('[sync] INBOX 新邮件 ' + inboxNew.length + ' 封');

    // 已发件文件夹：先列出真实文件夹名再决定，不再逐个试名字（旧版每个不存在的
    // 名字都耗满 60 秒超时，00:39 那次 3 分钟悄无声息就是这么烧掉的）。
    var sentBox = await findSentBox(imap);
    console.log('[sync] 已发件文件夹：' + (sentBox || '未找到，跳过已发件'));
    var sentHeaders = [];
    if (sentBox) {
      try {
        sentHeaders = await fetchHeaders(imap, simpleParser, sentBox, since);
        console.log('[sync] ' + sentBox + ' 信头 ' + sentHeaders.length + ' 封');
      } catch (e) {
        console.log('[sync] 已发件信头拉取失败，跳过已发件：' + e.message);
        sentHeaders = [];
      }
    }
    var sentNew = sentHeaders
      .filter(function (h) { return h.messageId && !knownIds[h.messageId]; })
      .sort(function (a, b) { return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0); });
    console.log('[sync] 已发件新邮件 ' + sentNew.length + ' 封');
    summary.fetched = inboxHeaders.length + sentHeaders.length;

    // 每轮只处理最新的 MAX_NEW_PER_RUN 封新邮件，其余下次同步继续。
    var inboxTake = inboxNew.slice(0, MAX_NEW_PER_RUN);
    var sentTake = sentNew.slice(0, Math.max(0, MAX_NEW_PER_RUN - inboxTake.length));
    if (inboxNew.length > inboxTake.length || sentNew.length > sentTake.length) {
      summary.errors.push('本轮只处理最新的 ' + MAX_NEW_PER_RUN + ' 封新邮件，其余 ' +
        ((inboxNew.length - inboxTake.length) + (sentNew.length - sentTake.length)) +
        ' 封下次同步继续。');
    }
    var inboxRes = inboxTake.length ? await fetchBodiesBatched(imap, simpleParser, 'INBOX',
      inboxTake.map(function (h) { return h.uid; }).filter(Boolean), pastDeadline) : { mails: [], skipped: 0 };
    var inbox = inboxRes.mails;
    console.log('[sync] INBOX 正文拉到 ' + inbox.length + ' 封' +
      (inboxRes.skipped ? '，跳过 ' + inboxRes.skipped + ' 封（拉取超时，下次重试）' : ''));
    if (inboxRes.skipped) summary.errors.push('INBOX 有 ' + inboxRes.skipped + ' 封新邮件正文拉取超时未入库，下次同步重试。');
    var sentRes = { mails: [], skipped: 0 };
    if (sentTake.length && sentBox) {
      sentRes = await fetchBodiesBatched(imap, simpleParser, sentBox,
        sentTake.map(function (h) { return h.uid; }).filter(Boolean), pastDeadline);
      console.log('[sync] ' + sentBox + ' 正文拉到 ' + sentRes.mails.length + ' 封' +
        (sentRes.skipped ? '，跳过 ' + sentRes.skipped + ' 封（拉取超时，下次重试）' : ''));
      if (sentRes.skipped) summary.errors.push('已发件有 ' + sentRes.skipped + ' 封新邮件正文拉取超时未入库，下次同步重试。');
    }
    var sent = sentRes.mails;

    // 3) 逐封处理（每封处理完立即入库，不攒着；临近截止时间就停，返回部分结果）
    var jobs = [];
    inbox.forEach(function (m) { jobs.push({ parsed: m, direction: 'in' }); });
    sent.forEach(function (m) { jobs.push({ parsed: m, direction: 'out' }); });

    for (var j = 0; j < jobs.length; j++) {
      if (pastDeadline()) {
        summary.errors.push('接近 ' + (SYNC_DEADLINE_MS / 1000) + ' 秒截止时间，剩余 ' +
          (jobs.length - j) + ' 封新邮件下次同步继续。');
        break;
      }
      var parsed = jobs[j].parsed;
      var direction = jobs[j].direction;
      try {
        if (!parsed || parsed._parseError) throw new Error('邮件解析失败：' + (parsed ? parsed._parseError : '空邮件'));
        var messageId = String(parsed.messageId || '').trim();
        if (!messageId) continue; // 没有 Message-ID 的无法去重，跳过
        if (knownIds[messageId]) continue; // 已在库里，跳过
        knownIds[messageId] = true;

        var fromEmail = addrOf(parsed.from).toLowerCase();
        var toList = parsed.to && parsed.to.value ? parsed.to.value.map(function (v) { return (v.address || '').toLowerCase(); }) : [];
        var counterpart = direction === 'in' ? fromEmail : (toList[0] || '');
        var subject = String(parsed.subject || '');
        var bodyText = String(parsed.text || '');
        var sentAt = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();
        var inReplyTo = String(parsed.inReplyTo || '');
        var refs = String(parsed.references || '');
        // 自己发给自己的信（收件箱里 from 是自己，如给自己留的客户备注）和云邮系统
        // 通知（noreply@yunyou.top 安全提醒）：只入库留档做去重，不进待判断、不改
        // 任何跟进状态。2026-11-16 首轮同步曾把这类信标成待判断，混进了人工池。
        var isSelfOrSystem = direction === 'in' &&
          (fromEmail === user.toLowerCase() || fromEmail === 'noreply@yunyou.top');

        // 匹配：先 In-Reply-To / References 对上已有往来，再按对方邮箱对上客户
        var match = null;
        if (inReplyTo && threadMap[inReplyTo]) match = threadMap[inReplyTo];
        if (!match) {
          var refTokens = refs.split(/\s+/).filter(Boolean);
          for (var k = 0; k < refTokens.length && !match; k++) if (threadMap[refTokens[k]]) match = threadMap[refTokens[k]];
        }
        var customer = match && match.customer_id
          ? customers.find(function (c) { return String(c.id) === String(match.customer_id); }) || null
          : (byEmail[counterpart] || null);
        var inquiryId = match ? match.inquiry_id : null;
        var matched = !!(customer || inquiryId);

        // 对不上任何客户：收到的新询盘自动建档；发出的也建档（是你主动联系的客户）
        if (!customer && counterpart && counterpart.indexOf('@') !== -1 &&
            counterpart !== user.toLowerCase()) {
          var created = await sb.insert('followup_customers', {
            name: nameOf(direction === 'in' ? parsed.from : parsed.to) || counterpart.split('@')[0],
            company: '',
            email: counterpart,
            stage: '待处理',
            // v3：新客户默认未验证、无线索标签、计数 0；验证与打标签在来发信/人工确认后补。
            verification_status: 'unverified',
            tags: [],
            outreach_count: 0,
            read_count: 0,
            health_score: 50,
            last_contact_at: sentAt,
            next_action: '新客户来信，先确认公司与产品需求'
          });
          customer = created && created[0] ? created[0] : null;
          if (customer) {
            byEmail[counterpart] = customer;
            customers.push(customer);
            var inq = await sb.insert('followup_inquiries', {
              customer_id: customer.id,
              product: '',
              summary: snippetOf(subject + ' ' + bodyText, 200),
              status: '待处理',
              stage: '新询盘',
              reply_status: direction === 'in' ? '已回复 · 待判断' : '未回复 · 等待客户',
              first_inquiry_at: sentAt,
              last_reply_at: direction === 'in' ? sentAt : null,
              next_action: '新客户来信，先确认公司与产品需求'
            });
            inquiryId = inq && inq[0] ? inq[0].id : null;
          }
        }
        // 有客户但没有询盘：补一条询盘壳（后续人工补产品）
        if (customer && !inquiryId) {
          var existing = await sb.list('followup_inquiries',
            'select=id&customer_id=eq.' + encodeURIComponent(customer.id) + '&order=created_at.desc&limit=1');
          if (existing && existing[0]) {
            inquiryId = existing[0].id;
          } else {
            var inq2 = await sb.insert('followup_inquiries', {
              customer_id: customer.id, product: '', summary: snippetOf(subject, 200),
              status: '待处理', stage: '新询盘',
              reply_status: direction === 'in' ? '已回复 · 待判断' : '未回复 · 等待客户',
              first_inquiry_at: sentAt,
              last_reply_at: direction === 'in' ? sentAt : null,
              next_action: '先看客户最新回复，再决定下一步'
            });
            inquiryId = inq2 && inq2[0] ? inq2[0].id : null;
          }
        }

        // 分类：只有收到的信才需要判断；发出的信不需要；自己/系统信直接记 other、不进待判断
        var cls = { intent: 'other', confidence: 'high' };
        var needsReview = false;
        if (direction === 'in' && !isSelfOrSystem) {
          cls = classifyEmail(subject, bodyText, fromEmail);
          needsReview = cls.intent === 'auto_unknown';
        }

        await sb.insert('followup_emails', {
          customer_id: customer ? customer.id : null,
          inquiry_id: inquiryId || null,
          message_id: messageId,
          thread_id: '',
          in_reply_to: inReplyTo,
          refs: refs,
          direction: direction,
          from_email: fromEmail,
          to_email: toList.join(','),
          subject: subject,
          snippet: snippetOf(bodyText, 200),
          body_text: String(bodyText || '').slice(0, 20000),
          sent_at: sentAt,
          intent: cls.intent,
          intent_confidence: cls.confidence,
          needs_review: needsReview
        });
        summary.new++;
        if (matched) summary.matched++;
        if (needsReview) summary.needs_review++;

        // 更新跟进状态（保守：只改时间与下一步，不自动成交/丢单）。
        // 自己/系统信不更新任何跟进状态（上面已说明）。
        if (inquiryId && !isSelfOrSystem) {
          if (direction === 'in') {
            // 待判断是 reply_status（原文口径），不是 status 桶：status 桶由日期 + stage 计算
            await sb.update('followup_inquiries', inquiryId, {
              last_reply_at: sentAt, reply_status: '已回复 · 待判断',
              next_action: '先看新回复，再决定阶段', updated_at: new Date().toISOString()
            });
            // v3 回信自动停：客户一回信，该询盘下未完成的自动待办一次停掉，
            // 并在跟进历史里留一行记录。注意：只停待办——回复仍是“已回复 · 待判断”，
            // 绝不自动标为已处理，必须人工看一次。
            try {
              var stopped = await sb.updateWhere('followup_todos',
                'inquiry_id=eq.' + encodeURIComponent(inquiryId) + '&done=eq.false',
                { done: true, stopped_by_reply: true });
              var stoppedN = Array.isArray(stopped) ? stopped.length : 0;
              summary.auto_stopped += stoppedN;
              if (stoppedN > 0) {
                await sb.insert('followup_history', {
                  customer_id: customer ? customer.id : null, inquiry_id: inquiryId,
                  profile_no: '', inquiry_no: '', record_no: 'auto-stop-' + inquiryId + '-' + Date.now(),
                  record_type: '回信自动停',
                  content: '客户已回复，自动停止未完成的跟进待办 ' + stoppedN + ' 条；回复仍为“已回复 · 待判断”，待人工确认。',
                  recorded_at: new Date().toISOString()
                });
              }
            } catch (e) { summary.errors.push('回信自动停失败：' + e.message); }
            // v3 阅读计数：收到一封匹配到的回复，read_count +1
            if (customer) {
              try {
                await sb.update('followup_customers', customer.id, {
                  read_count: (parseInt(customer.read_count, 10) || 0) + 1,
                  last_contact_at: sentAt, updated_at: new Date().toISOString()
                });
                customer.read_count = (parseInt(customer.read_count, 10) || 0) + 1;
              } catch (e) { summary.errors.push('阅读计数失败：' + e.message); }
            }
          } else {
            // 只往后推，不往前推；且只设未来的日期：旧邮件的 sent+3 可能比用户已
            // 确认的下次跟进日期更早，不能把已确认的日期往回改（01:10 那轮因此多
            // 出 19 条逾期）；当前无日期（待定日期）时，过期了的 sent+3 也不写，
            // 留空待用户确认（01:16 那轮又有 11 条因此变逾期）。
            var newNext = addDaysStr(sentAt, 3);
            var today = new Date().toISOString().slice(0, 10);
            var curNext = null;
            try {
              var curInq = await sb.list('followup_inquiries',
                'select=next_followup_at&id=eq.' + encodeURIComponent(inquiryId) + '&limit=1');
              if (curInq && curInq[0]) curNext = curInq[0].next_followup_at || null;
            } catch (e) { /* 读不到当前日期就按原来的写 */ }
            var patchOut = { updated_at: new Date().toISOString() };
            if (newNext >= today && (!curNext || newNext > String(curNext).slice(0, 10))) {
              patchOut.next_followup_at = newNext;
            }
            await sb.update('followup_inquiries', inquiryId, patchOut);
            // v3：你发出的跟进邮件默认建一条 +3 天的待办（与前端写跟进一致）；
            // 指纹冲突（同一天已建过）时跳过，不报错。到期日已过的旧邮件不建
            // （建了也是立刻逾期的旧待办，询盘自己的下次跟进日期说了算）。
            try {
              var todoDue = addDaysStr(sentAt, 3);
              if (todoDue >= new Date().toISOString().slice(0, 10)) {
                await sb.insert('followup_todos', {
                  customer_id: customer ? customer.id : null,
                  inquiry_id: inquiryId,
                  reason: '跟进邮件已发出：' + subject,
                  next_action: '等客户回复；' + todoDue + ' 前未回再跟进一次',
                  due_at: todoDue,
                  done: false,
                  stopped_by_reply: false,
                  fingerprint: 'sync-out|' + inquiryId + '|' + todoDue
                });
                summary.todos_created++;
              }
            } catch (e) { /* 指纹冲突即已建过，跳过 */ }
            // v3 开发计数：发出一封跟进邮件，outreach_count +1
            if (customer) {
              try {
                await sb.update('followup_customers', customer.id, {
                  outreach_count: (parseInt(customer.outreach_count, 10) || 0) + 1,
                  last_contact_at: sentAt, updated_at: new Date().toISOString()
                });
                customer.outreach_count = (parseInt(customer.outreach_count, 10) || 0) + 1;
              } catch (e) { summary.errors.push('开发计数失败：' + e.message); }
            }
          }
        } else if (customer && !isSelfOrSystem) {
          await sb.update('followup_customers', customer.id, {
            last_contact_at: sentAt, updated_at: new Date().toISOString()
          });
        }
      } catch (e) {
        summary.errors.push(e.message);
      }
    }

    // 4) 写同步状态（成功也写，供前端显示“上次同步”）
    try {
      await sb.upsertSyncState({
        last_sync_at: new Date().toISOString(),
        last_message_id: '',
        last_error: summary.errors[0] || '',
        provider: 'yunyou.top',
        updated_at: new Date().toISOString()
      });
    } catch (e) { summary.errors.push('写同步状态失败：' + e.message); }

    console.log('[sync] 完成：拉取 ' + summary.fetched + ' 封，新增 ' + summary.new +
      ' 封，匹配 ' + summary.matched + ' 封，待判断 ' + summary.needs_review +
      ' 封，自动停 ' + summary.auto_stopped + ' 条，建待办 ' + summary.todos_created +
      ' 条，用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒');
    res.status(200).json(summary);
  } catch (e) {
    console.log('[sync] 失败：' + e.message);
    res.status(500).json({
      error: 'sync_failed', message: e.message,
      fetched: summary.fetched, new: summary.new, matched: summary.matched,
      needs_review: summary.needs_review, auto_stopped: summary.auto_stopped,
      todos_created: summary.todos_created, errors: summary.errors
    });
  } finally {
    if (imap) { try { imap.end(); } catch (e) { /* 忽略关闭时的错误 */ } }
  }
};

// Node 下测试用
module.exports.classifyEmail = classifyEmail;
module.exports.addDaysStr = addDaysStr;
