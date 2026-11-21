# 客户跟进工作台（重做版）— Vercel + Supabase

旧站是 ChatGPT 托管的 `neoprene-followup-kevin.kevin-ho-chine.chatgpt.site`，无源码、改不了。
这是按它重做的你自己的版本：页面在 Vercel，数据在 Supabase，邮箱同步在 Vercel 后台函数里做。

旧站口径（2026-11-15 截图）：客户档案 216，全部询盘 202，今天应跟进 10，已逾期 106，
回复待判断 122，等待客户 66，跟进清单 194。
**本仓库不含真实客户数据**（前端无示例客户，未导入时显示空态 + 导入提示）；
真实数据用 `import/` 里的脚本从旧站导出文件导入（下面第 5 步），导入后 4 张卡应为 10 / 106 / 122 / 66。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` / `style.css` / `app.js` | 前端单页：4 张状态卡、跟进清单、客户档案、项目与订单、经营汇总、供应商与物流、回复待判断、同步邮箱按钮 |
| `supabase-followup.sql` | 建表 SQL（12 张表），在 Supabase SQL Editor 执行 |
| `api/sync-email.js` | Vercel 后台函数：IMAP 只读同步 + 保守自动分类 |
| `vercel.json` | `cleanUrls`（与工作面板、PI 生成器一致） |
| `config.example.js` | 前端配置示例，复制为 `config.js` 后填真实 key |
| `package.json` | 后台函数依赖：`imap`、`mailparser` |

## 规则（都在 `app.js` 顶部，一处可改）

- 逾期按**下次跟进日期**算：日期过了今天即逾期，无日期即待定日期（旧站口径，实测与首页 106 / 10 一致）。
  **7 天**无互动（`OVERDUE_DAYS = 7`）不直接改卡片数字，只进“今日待办建议”
  （否则会把逾期从 106 虚增到 110，见 `app.js` 里 `computeInquiryStatus` 的注释）
- 你回了客户 / 确认了客户回复后，下次跟进默认往后推 **3 天**（`FOLLOWUP_DELAY_DAYS = 3`）
- 每天扫描的待办最多 **10 条**，每条写清为什么 + 下一步（`MAX_TODOS_PER_RUN = 10`）
- 自动分类很保守：只有退信 / 退订 / 明确拒绝 / 明确下单这 4 种才自动定，
  其余一律 `intent = auto_unknown`，留在“回复待判断”里人工点一次。

## LaiFaXin 做法（2026-11-15 并入，分工：来发信只做搜客 / 验证 / 群发，本系统管跟进）

1. **保存前去重**：导入或手动添加客户时，邮箱小写相同，或同一家公司 + 同一非免费邮箱域名
   （gmail / hotmail 等免费域名排除），不重复建——导入跳过并计数（`import-from-xlsx.py`），
   前端命中时弹窗告知已存在的是哪一位（`app.js` 的 `findDuplicateCustomer`）。
2. **邮箱验证状态**：`followup_customers.verification_status`，
   valid 有效 / unknown 未知 / invalid 无效 / verifying 验证中 / unverified 未验证（默认）。
   只有 valid / unknown 以后可群发（群发在来发信里做）；前端客户档案里显示徽章。
3. **标签命名 产品｜行业｜年月**：`followup_customers.tags`（text[]），
   例如 NEO-WS｜潜水服水上运动｜2026-08，另可加来源标签（如 潜水料客户-LK251106）。
   导入时只按导出文件已有的字段播种（客户来源原文 + 产品类别｜询盘年月），
   导出文件里没有“行业”列，行业段不编造，缺的留空、人工后补。
4. **写跟进默认建待办**：编辑跟进保存时默认勾选“同时创建待办”，到期日默认 +3 天
   （`DEFAULT_TODO_DAYS = 3`，在 `app.js` 顶部，与 `FOLLOWUP_DELAY_DAYS` 保持一致）；
   同步发出的跟进邮件也一样建一条 +3 天待办（`api/sync-email.js`）。
5. **开发 / 阅读计数**：`outreach_count` / `read_count`（默认 0），
   同步发出一封跟进邮件 +1，收到一封匹配到的回复 +1；客户档案里显示“发出 / 已读”。
6. **回信自动停**：客户一回信（同步匹配到，或人工确认），该询盘下未完成的自动待办
   一次置 `done=true` + `stopped_by_reply=true`，并在跟进历史里留一行“回信自动停”记录；
   回复仍是“已回复 · 待判断”，绝不自动标为已处理（`api/sync-email.js` + `app.js` 的 `autoStopTodosForInquiry`）。
7. **导出全部字段 + 每日上限**：页面“导出 CSV”按钮导出当前筛选结果（筛选 + 搜索都生效），
   一行一条询盘，无询盘的客户也各占一行，字段是全部字段、不只是页面上看得见的列；
   每日上限 50,000 行/天（`EXPORT_DAILY_CAP`，在 `app.js` 顶部），计数存在浏览器 localStorage、按天归零，
   超限直接拦截并提示。

## 1. 建表（Supabase）

项目：**neoprene-order-assistant**（https://gplkvdodbfzknyafdttb.supabase.co，复用，不新建；
免费版已满 2 个项目）。Supabase 控制台 → SQL Editor → 粘贴执行 `supabase-followup.sql`。
只新增 12 张表，不动现有的 `panel_*` 表：

- `followup_customers`（客户档案，邮箱唯一匹配键）
- `followup_inquiries`（询盘；状态含旧站的“回复待判断”）
- `followup_emails`（邮件原文，按 Message-ID 去重）
- `followup_todos`（待办，指纹去重）
- `followup_sync_state`（同步状态，id=1 单行）
- `followup_orders` / `followup_suppliers`（2026-11-16 新增，见下）

## 项目与订单 / 经营汇总 / 供应商与物流（2026-11-16 新增）

来源：旧站项目与订单页 45 条、供应商与物流页 10 家（2026-11-16 用户登录旧站后只读抄录，
`import/old-orders.csv`、`import/old-suppliers.csv`，说明见 `import/old-system-notes.md`）；
经营汇总的口径见 `import/Neoprene_经营汇总_2026_11月.xlsx` 的“统计口径”表。

- **新表**：`followup_orders`（订单编号唯一；阶段、金额、汇率、成本、利润状态待确认/预计/已核对；
  与客户只按公司名精确匹配，单名客户如 Abdullah、Marta 匹配不上时 `customer_id` 留空）；
  `followup_suppliers`（名称唯一；类型只分供应商/物流商；空字段原文就是“待补充”，原样存）。
  两表与其它 `followup_*` 表一样用 anon 读写 RLS。
- **新视图**：项目与订单（类型/搜索/客户/阶段筛选，点客户名筛该客户，利润栏待确认不显示成 0）、
  经营汇总与报表（按月现算：新增询盘、成交客户、销售额、已核对/预计利润、成交率、每日利润柱状图与每日明细）、
  供应商与物流（搜索 + 类型筛选）。三个视图的数据都由前端实时算出，不写死数字。
- **导入**：`python3 import/import-orders-suppliers.py`（默认 dry-run，只计数 + 校验；
  `--live` 才写库，需 `SUPABASE_URL` + `SUPABASE_ANON_KEY`）。干跑已验证：45 条订单、10 家伙伴、
  0 警告；已确认订单 26 笔；2026-11 复核 11 条询盘 / 3 位成交客户 / 销售额 US$1,178.50 /
  ¥7,833.99 / 已核对利润 ¥1,563.99（2/2 笔可计算）/ 成交率 0.0%，与旧站 11 月汇总一致。
- **口径要点**：确认订单 = 阶段含订单确认/采购/已出货/已完成；销售额 = 已确认订单 +
  其它未取消且已核对利润的项目（每单只计一次）；人民币销售额逐单用该单汇率四舍五入到分再汇总，
  缺金额或汇率的订单列为待补、不计为 0；成交客户 = 本月已确认订单客户 ∪ 本月首次进入已成交的
  询盘客户（跟进历史里 content 含“阶段：已成交”的最早一条，UTC +8 小时取北京时间；无此历史时
  回退到询盘创建日），按客户去重。

## 2. 前端配置

```bash
cp config.example.js config.js
```

填 `config.js` 里的 `SUPABASE_ANON_KEY`（Supabase 项目设置 → API → anon public key）。
`config.js` **不要提交到 GitHub**（建仓库时加 `.gitignore`，写一行 `config.js`）。
没有 `config.js` 时页面显示空态 + 黄色导入提示条（不含任何示例客户），配置并导入后显示真实数据。

## 3. 部署（GitHub + Vercel，与工作面板、PI 生成器同一流程）

```bash
# 新建公开仓库 kevin-neoprene/neoprene-followup，把本目录文件推上去（不含 config.js）
# Vercel → Add New Project → Import 该仓库 → Deploy
npm install   # 本地先装一次，确认 imap、mailparser 能装上
```

## 在系统内回邮件（2026-11-21）

- 回复框在 回复待判断（询盘卡片 + 邮件卡片）和询盘的编辑跟进行里：上面显示原邮件，
  下面填收件人 / 主题 / 正文 / 下次跟进日期（默认今天 +3 天，可改）。
- 点 发送 前会弹出确认框，再显示一次收件人、主题、正文，只在用户点发送时才发，
  绝不自动发；一次只发给一个客户，不做群发（群发走来发信）。
- 后端 `api/send-email.js`（Vercel Serverless）：SMTP smtp.yunyou.top:465 SSL，
  账号密码复用现有的 `IMAP_USER` / `IMAP_PASS` 环境变量（云邮 SMTP 就是登录密码），
  密码只从环境变量读，绝不写进代码、绝不打日志、绝不返回给前端。依赖 nodemailer。
- 服务端核对收件人：必须是该询盘客户档案里的邮箱、往来邮件的发件人，或自己的邮箱
  （自测），否则 400 拒绝。原邮件有 Message-ID 时带 In-Reply-To / References，
  在 Foxmail 和对方邮箱里落在同一封 thread 里；发件人固定是 kevin@neoprenecustom.com。
- 发完：询盘 reply_status → `未回复 · 等待客户`，下次跟进按框里的日期，
  跟进历史记一行 `发邮件`，按 v3 规则建一条待办（指纹 `sync-out|询盘|日期`），
  原邮件标 needs_review = false。发出的信不直接入库，下次同步时从已发件里拉回
  来归档，沿用现有规则（只把下次跟进往后推，不往前改）。

## 4. 邮箱同步（Vercel 环境变量）

邮箱：**yunyou.top（西部数码云邮）**，IMAP `imap.yunyou.top:993` SSL，
SMTP `smtp.yunyou.top:465/587`。**IMAP 用邮箱登录密码，没有单独的客户端授权码**
（用户 2026-11-15 确认）。密码值不要在聊天、代码、仓库里出现，
部署时直接在 Vercel 项目设置 → Environment Variables 里填：

| 变量 | 值 |
|---|---|
| `IMAP_HOST` | `imap.yunyou.top` |
| `IMAP_PORT` | `993` |
| `IMAP_USER` | `kevin@neoprenecustom.com` |
| `IMAP_PASS` | 云邮登录密码（仅存 Vercel） |
| `SUPABASE_URL` | `https://gplkvdodbfzknyafdttb.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key（服务端写库用，绝不要用 anon key） |
| `SYNC_DAYS` | `90`（可选，每次往回扫多少天） |

部署前还需确认：**网页邮箱设置里 IMAP 已开启**（mail.neoprenecustom.com 或
mail.yunyou.top 里看一眼）。没开的话同步会报连接失败。

同步是只读的：IMAP 只读开箱，不删、不移、不标已读；写操作只发生在自家 Supabase。
匹配顺序：先 `In-Reply-To` / `References` 对上已有往来，再按对方邮箱对上客户；
都对不上就自动新建客户 + 询盘（状态“待处理”，等人工确认公司与产品名）。

部署后点页面上的“同步邮箱”按钮验证，成功会显示拉取 / 新增 / 匹配 / 待判断的数量。

### 定时同步（先手动，跑顺了再加）

Vercel Hobby 版的 Cron 有数量与频率限制，且免费版不支持太密的定时，
所以首版只做手动“同步邮箱”按钮。跑顺后如需定时，在 `vercel.json` 里加：

```json
{ "crons": [{ "path": "/api/sync-email", "schedule": "0 1 * * *" }] }
```

注意：Cron 调的是 GET，届时需把 `api/sync-email.js` 的 POST 限制放宽为
POST 或带密钥的 GET（不要无鉴权开放 POST 给全网）。

## 5. 导入真实数据（旧站导出文件已收到）

导出文件：`Neoprene______2026-11-15.xlsx`（导出时间 2026-11-15 22:12:30），
9 个表：客户档案 **216** / 关联询盘 **201** / 询盘跟进历史 **310** /
跟进评估 **216** / 中文背调 216 / 背调来源 525 / 关联社媒 157 / 官网提取记录 18。
字段映射见 [import/FIELD_MAPPING.csv](import/FIELD_MAPPING.csv)，
完整说明见 [import/IMPORT.md](import/IMPORT.md)。

主键：**客户档案编号**贯穿所有表，**询盘编号**连接询盘 ↔ 跟进历史；
邮箱是邮件同步的匹配键（小写去重；本次导出 216 个全有且唯一，0 空邮箱）。

```bash
# 干跑：只计数 + 校验，不写库（先跑这个）
python3 import/import-from-xlsx.py "/home/hatch/workspace/user/files/Neoprene______2026-11-15.xlsx"
# 生成 SQL，粘贴到 Supabase SQL Editor 执行（推荐）
python3 import/import-from-xlsx.py "/home/hatch/workspace/user/files/Neoprene______2026-11-15.xlsx" --sql-out /tmp/followup-import.sql
# 或直接写库（需 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY）
SUPABASE_URL=https://gplkvdodbfzknyafdttb.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
  python3 import/import-from-xlsx.py "/home/hatch/workspace/user/files/Neoprene______2026-11-15.xlsx" --live
```

干跑已验证（2026-11-15）：216 + 201 + 310 + 216 + 525 + 157 + 18 行，
主键全部唯一，0 孤儿引用，0 警告；卡片复核 10 / 106 / 194 / 122 / 66 与旧站首页一致。

**差异：201 vs 202。** 旧站首页曾显示 202 条询盘，导出文件只有 201 条。
用 201 条复核：今天 10、逾期 106、进行中 194、待判断 122、等待客户 66 全部对得上，
说明 201 条自洽，多出的 1 条在文件里找不到。**按 201 条导入，不硬凑 202。**

**备选：邮箱历史导入。** 如需补全历史，把 `SYNC_DAYS` 临时调大（如 180），
点一次同步，系统按发件人自动建客户 / 询盘；数量以邮箱实际为准，
导入后核对一份差异清单。注意跟进历史里只有 8 条“客户新回复”，
大部分待判断回复的原文只在询盘的“最近回复”列，同步上线后由 `followup_emails` 补上。

## 验证清单（部署后逐项打勾）

- [ ] 导入后 4 张卡显示：今天应跟进 10、已逾期 106、回复待判断 122、等待客户 66；客户档案 216；跟进清单 194
- [ ] 跟进清单的 6 个筛选（全部进行中 / 待处理 / 今天应跟进 / 已逾期 / 等待客户 / 待定日期）都能点
- [ ] 搜索客户 / 公司 / 产品能找到对应记录
- [ ] 编辑一条跟进（改当前阶段 / 下一步 / 下次日期）后刷新页面还在；默认勾选的待办已建（到期 +3 天）
- [ ] 回复待判断里确认 1 条，卡片数字减 1，下次跟进往后推 3 天；该询盘未完成的待办被自动停掉
- [ ] 点“同步邮箱”：未配环境变量时显示“邮箱未连接”提示；配好后返回拉取数量
- [ ] 添加一个已存在邮箱的客户时被拦下并提示是哪一位；客户档案里能看到验证徽章、标签、发出/已读计数
- [ ] 点“导出 CSV”：导出的是一行一条询盘的全部字段（含档案编号、验证、标签、计数），无询盘客户也在内；每日上限 50,000 行
- [ ] 跑顺后把新网址加到工作面板快捷入口“客户跟进”
