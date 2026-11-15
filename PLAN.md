# 客户跟进系统重做 — Vercel + Supabase 方案（带邮箱同步）

日期：2026-11-15（用户已确认重做）
旧站：https://neoprene-followup-kevin.kevin-ho-chine.chatgpt.site/（ChatGPT 托管，无源码，无法直接改）
新站：Vercel 前端 + Supabase 后端，复用现有项目（免费版已满 2 个，不新建）

## 1. 旧站结构（依据用户截图 image-21.png，2026-11-15）

左侧导航：
- 跟进工作台
- 客户档案 216
- 项目与订单 45
- 经营汇总与报表
- 供应商与物流
- 全部询盘 202
- 回复待判断 122
- 归档与暂缓

首页 4 张卡（2026-11-15 当天）：
- 今天应跟进 10 条 — 按你确认的日期安排
- 已逾期 106 条 — 重新判断，再安排下一步
- 回复待判断 122 条 — 先看新回复，再决定阶段
- 等待客户 66 条 — 保持耐心，不自动催单

跟进清单 194 条：全部进行中 / 待处理 154 / 今天应跟进 / 已逾期 / 等待客户 / 待定日期
搜索：客户、公司或产品。列：客户/询盘需求 | 阶段与回复 | 下一步动作 | 下次跟进
示例行：Neopren Service Thomas & Salomon — 11/10 跟进客户是否提供收货地址与联系电话，已发样品包（A4 样品与色卡：铁三…）
左侧提示：让跟进有依据 — 先读客户的回复，再决定下一步。

结论：新系统必须 1:1 还原这套口径，不能另发明一套状态，否则 216/202 这些数对不上。

## 2. 架构（沿用工作面板 / PI 生成器已验证的做法）

- 前端：静态单页 + JS，GitHub 仓库 `kevin-neoprene/neoprene-followup`（新建），Vercel 自动部署，得到独立网址，之后加到工作面板快捷入口“客户跟进”。
- 后端：Supabase 项目 `neoprene-order-assistant`
  （https://gplkvdodbfzknyafdttb.supabase.co，ap-southeast-1），只加新表，不动现有
  panel_tasks / panel_notes / panel_links / panel_inquiries 等表。
  沿用工作面板的简化 RLS 做法：单人自用，anon 可读写跟进表（见 supabase.sql 草稿）。
  客户邮箱属于客户资料，正常在系统内展示；不对外公开。
- 邮箱同步不在浏览器里直连邮箱：由一个定时同步任务（Vercel Cron / Supabase 定时，
  每 30 分钟一次，先做手动“同步邮箱”按钮再加定时）以只读方式拉取
  kevin@neoprenecustom.com 的收件箱 + 已发件，写入 `followup_emails`，
  再按规则更新客户 / 询盘状态。密码 / 授权只存在服务端环境变量，不进代码、不进聊天。

## 3. 表设计（草稿，见 supabase-followup.sql）

- `followup_customers`：id, name（客户名）, company, email（唯一匹配键，小写去重）,
  country, phone, source, stage, health_score（0-100）, last_contact_at,
  next_followup_at, next_action, notes, created_at, updated_at
- `followup_inquiries`：id, customer_id, product, quantity, message 摘要,
  status（待处理 / 今天应跟进 / 已逾期 / 等待客户 / 待定日期 / 已成交 / 已丢单 / 归档）,
  first_inquiry_at, last_reply_at, next_followup_at, next_action
- `followup_emails`：id, customer_id, inquiry_id, message_id（邮箱 Message-ID，去重键）,
  thread_id, in_reply_to, references, direction（in/out）, from_email, to_email,
  subject, snippet, body_text, sent_at, intent（见 §4）, intent_confidence,
  needs_review（bool）, created_at
- `followup_todos`：id, customer_id, inquiry_id, reason（为什么产生这条）,
  next_action, due_at, done, fingerprint（去重指纹）, created_at
- `followup_sync_state`：id=1 单行，last_sync_at, last_uid / last_message_id,
  last_error, provider

## 4. 邮件自动判断规则（融合 GoodJob 可移植部分，2026-11-15 评估结论）

不部署整个 GoodJob CRM，只搬它的跟进 / 回邮处理设计：

匹配（按优先级）：
1. In-Reply-To / References 对上已有的 thread → 归到同一条询盘
2. 发件人邮箱对上 `followup_customers.email` → 归到该客户
3. 都对不上 → 新客户：自动建档 + 新建询盘，状态=待处理，需人工确认公司/产品名

分类（保守原则：只有确定的才自动改，不确定的进“回复待判断”人工看）：
- 确定自动：退信 bounce / 退订 unsubscribe / 明确拒绝 reject / 明确下单 demand
- 其余一律 `intent = auto_unknown`，needs_review=true，留在 122 条待判断池里，
  人工点一次即学习（下次同类表述可沿用）
- 关键词只做辅助提示，不做自动成交/丢单判定：报价 quote / 样品 sample / 价格 price /
  付款 payment / 地址 address / 电话 phone 等只填到摘要里

跟进维护（GoodJob 规则直接抄）：
- 每天扫描一次：7 天无互动、health < 60、缺下一步动作、已逾期未排下一步的，
  生成待办，每次最多 10 条，生成前先预览，每条写清为什么 + 下一步动作
- 指纹去重：同一客户+同一原因不重复建待办
- 你回了客户 → 记一次跟进，next_followup_at 往后推（默认 +3 天，可改）
- 客户回了 → last_reply_at 更新，状态从 已逾期/今天应跟进 → 回复待判断
- 已逾期按“下次跟进日期过了今天”算（实测与旧站 106 一致）；7 天无互动（GoodJob 口径）
  不直接改卡片数字，只进每日待办扫描的触发条件，等用户确认是否改。
  （教训：曾用 7 天规则推断逾期，实测会把 106 虚增到 110——15 条空日期里有 4 条
  超过 7 天无互动，但旧站把它们算待定日期。）

## 5. 数据迁移

已收到（2026-11-15 22:11）：~/workspace/user/files/Neoprene______2026-11-15.xlsx，
383KB，导出时间 2026-11-15 22:12:30 北京时间，9 个表：
客户档案 216 条、关联询盘 201 条、询盘跟进历史 310 条、跟进评估 216 条、
中文背调 216 条、背调来源 525 条、关联社媒 157 条、官网提取记录 18 条、导出说明。
主键：客户档案编号（贯穿所有表）、询盘编号（关联询盘 ↔ 跟进历史）。
注意差异：首页显示全部询盘 202 条，导出文件里是 201 条，差 1 条，导入时核对、
不要硬凑 202。已用 201 条逐项复核：今天 10 / 逾期 106 / 进行中 194 / 待判断 122 /
等待客户 66 与首页全部一致，201 条自洽（详见 import/IMPORT.md）。
- 邮箱：216 个全有且唯一，0 空邮箱、0 重复、0 孤儿引用；无“缺邮箱”行。
- 字段映射见 import/FIELD_MAPPING.csv；导入脚本 import/import-from-xlsx.py（默认 dry-run，
  已跑通：216+201+310+216+525+157+18 行，0 警告）；说明见 import/IMPORT.md。
- 备用方案（导出不可用时才用）：直接从邮箱历史扫（先扫最近 6 个月收件箱+已发件），
  按发件人自动建客户/询盘，导入后给用户一份差异清单核对。

## 6. 待用户确认（阻塞项，做不了就不能往下走）

1. 邮箱已确认（2026-11-15 22:08，用户亲口说）：yunyou.top，西部数码云邮。
   官方设置（West.cn 文档）：IMAP imap.yunyou.top:993 SSL / 143，
   SMTP smtp.yunyou.top:465/587，POP3 pop3.yunyou.top:995，
   MX mx1.yunyou.top / mx2.yunyou.top，网页版 mail.neoprenecustom.com 或 mail.yunyou.top。
   注意：Muse 自带的 IMAP 连接器对这个账号不可用（2026-11-15 查过，
   connector_manifest_account_not_eligible），所以不能由 Muse 直接读邮箱来验证；
   同步必须做在 Vercel 后台里，用 IMAP 直连，账号密码只存 Vercel 环境变量。
   用户 2026-11-15 22:10 确认：用登录密码，不用单独的客户端授权码。
   密码值不要在聊天里发，到时直接填进 Vercel 环境变量 IMAP_PASS（或安全表单），
   不进代码、不经我手。
   已确认 2026-11-15 22:20（截图 image-38.png）：IMAP服务 开启，POP3/SMTP 也开启，
   客户端独立密码 OFF —— 登录密码可直接用于 IMAP，邮箱侧不用再改。
   分工已定 2026-11-15 22:31：来发信只做搜客/验证/群发，自建系统管 216 客户跟进；
   来发信 7 条做法（保存前去重、验证状态枚举、标签 产品｜行业｜年月、默认 +3 天待办、
   开发/阅读计数、回信自动停、导出全部字段+每日上限）要加进本系统再部署。
   Gmail 在 Muse 里当前是未连接状态（2026-11-15 查过），与此无关。
2. 旧站能不能导出客户表？能 → 发 Excel/CSV；不能 → 走邮箱历史导入。
3. 待办触发天数：默认 7 天无互动进待办（不改卡片数字），是否改？下次跟进默认 +3 天是否改？

## 8. LaiFaXin 做法（2026-11-15 并入，7 条；分工已定）

分工：来发信只做搜客 / 验证 / 群发；自建 Vercel + Supabase 系统管 216 客户的跟进、
逾期、122 条待判断回复、商机与邮箱同步。以下 7 条已写进代码（README 有同款说明）：

1. 保存前去重（邮箱小写 / 同公司+同非免费域名）— import-from-xlsx.py + app.js findDuplicateCustomer
2. 邮箱验证状态枚举 valid/unknown/invalid/verifying/unverified（默认 unverified），只有 valid/unknown 可群发
   — supabase-followup.sql（建表 + v3 迁移段）/ FIELD_MAPPING.csv / 导入脚本 / 前端徽章
3. 标签 产品｜行业｜年月（如 NEO-WS｜潜水服水上运动｜2026-08）— tags text[]；
   导入只按导出文件播种（来源原文 + 产品类别｜询盘年月），行业段不编造
4. 写跟进默认建待办，默认 +3 天（DEFAULT_TODO_DAYS=3，与 FOLLOWUP_DELAY_DAYS 一致）— app.js 编辑行默认勾选 + sync-email.js 发出邮件建待办
5. 开发/阅读计数 outreach_count / read_count（默认 0）— 同步发出 +1 / 收到匹配回复 +1，前端客户档案显示
6. 回信自动停 — 同步匹配到回信或人工确认时，未完成待办 done=true + stopped_by_reply=true，
   跟进历史留痕；回复仍是“已回复 · 待判断”，绝不自动标已处理
7. 导出全部字段 + 每日上限 50,000 行/天（EXPORT_DAILY_CAP，localStorage 按天计数，超限拦截）— app.js 导出 CSV

## 7. 下一步（用户确认后）

1. 写 supabase-followup.sql → 在 Supabase SQL Editor 执行建表
2. 写前端（跟进工作台 + 客户档案 + 全部询盘 + 回复待判断 + 同步邮箱按钮）
3. GitHub 新建 kevin-neoprene/neoprene-followup → Vercel 部署 → 验证 4 张卡数字
4. 接邮箱（按用户给的服务商）→ 手动同步一次 → 核对 122 条待判断的分类是否正确
5. 加定时同步 + 加到工作面板快捷入口
