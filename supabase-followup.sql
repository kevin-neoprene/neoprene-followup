-- 客户跟进系统 Supabase 建表 SQL（v2 — 按真实导出文件修订）
-- 导出文件：~/workspace/user/files/Neoprene______2026-11-15.xlsx
--   导出时间 2026-11-15 22:12:30（北京时间），9 个表：
--   客户档案 216 / 关联询盘 201 / 询盘跟进历史 310 / 跟进评估 216 /
--   中文背调 216 / 背调来源 525 / 关联社媒 157 / 官网提取记录 18 / 导出说明
-- 项目：neoprene-order-assistant（https://gplkvdodbfzknyafdttb.supabase.co）
-- 在 Supabase 控制台 -> SQL Editor 粘贴执行；只新增表，不动现有 panel_* 表。
-- RLS 沿用工作面板做法：单人自用，anon 可读写（后续如需登录鉴权再收紧）。
--
-- 主键约定（贯穿所有表）：
--   客户档案编号 profile_no（UUID 文本，216 个唯一）— 客户在所有表的连接键
--   询盘编号 inquiry_no（UUID 文本，201 个唯一）— 询盘 ↔ 跟进历史的连接键
--   记录编号 record_no（UUID 文本，310 个唯一）— 跟进历史的去重键
--   邮箱 email（小写去重）— 邮件同步的匹配键；导出文件里 216 个邮箱全有且唯一
-- 注意 201 vs 202：旧站首页显示 202 条询盘，导出文件只有 201 条，且
--   下次跟进日期算出的逾期 106 / 今天 10、排除暂缓+已关闭+已成交后的 194、
--   待判断 126 排除暂缓/已关闭后的 122、等待客户 67 排除暂缓后的 66，
--   与首页数字全部对得上，说明 201 条是自洽的；多出的 1 条在文件里找不到，
--   导入时按 201 条导入并标注差异，绝不硬凑 202。

create table if not exists public.followup_customers (
  id uuid default gen_random_uuid() primary key,
  -- 旧站主键：客户档案编号（贯穿所有表）
  profile_no text not null default '',
  name text not null default '',            -- 联系人姓名
  company text not null default '',         -- 公司 / 品牌
  email text not null default '',           -- 邮箱（邮件匹配键，小写去重）
  country text not null default '',         -- 国家 / 地区
  job_title text not null default '',       -- 客户职位
  website text not null default '',         -- 官网
  phone text not null default '',           -- 手机号码
  whatsapp text not null default '',        -- WhatsApp
  other_contact text not null default '',   -- 其他联系方式
  customer_type text not null default '',   -- 客户类型（品牌商/制造商/贸易商/批发商/其他/空）
  source text not null default '',          -- 客户来源
  background text not null default '',      -- 客户背景
  notes text not null default '',           -- 客户备注
  whatsapp_verified text not null default '', -- WhatsApp 核实状态（215 未核实 / 1 客户提供）
  cn_background_status text not null default '', -- 中文背调状态（已完成 129 / 研究未完成 87）
  -- 跟进评估（跟进评估表，同 profile_no；当前重要等级 = 系统建议等级：A 21 / B 113 / C 5 / 待评估 77）
  grade text not null default '待评估',     -- 当前重要等级
  grade_source text not null default '',    -- 等级设置：系统自动判断 214 / 手动 A 2
  grade_reason text not null default '',    -- 手动等级理由
  eval_advice text not null default '',     -- 跟进建议
  eval_next_action text not null default '',-- 建议下一步（无空值；客户无询盘时作为 customers.next_action）
  eval_basis text not null default '',      -- 判断依据
  eval_missing_info text not null default '', -- 待补信息
  eval_limits text not null default '',     -- 核实限制
  eval_detail jsonb not null default '{}',  -- 评估输入项原样：产品与业务匹配/采购需求明确度/采购时间/合作潜力/客户联系意愿/采购量补充
  -- 旧站内部状态（前端用；stage 由等级映射：A 重点跟进 / B 正常推进 / C 暂缓 / 待评估）
  stage text not null default '待评估',
  -- v3 LaiFaXin 做法（2026-11-15 并入）：邮箱验证状态 / 标签 / 开发与阅读计数
  -- verification_status：valid 有效 / unknown 未知 / invalid 无效 / verifying 验证中 / unverified 未验证；
  --   只有 valid / unknown 以后可群发（群发在来发信里做，本系统不发群发邮件）。
  verification_status text not null default 'unverified'
    check (verification_status in ('valid','unknown','invalid','verifying','unverified')),
  -- tags：标签数组，命名约定 产品｜行业｜年月，例如 NEO-WS｜潜水服水上运动｜2026-08；
  --   另可加来源标签（如 潜水料客户-LK251106）。导入时只按导出文件已有的字段播种，缺的留空，绝不编造。
  tags text[] not null default '{}',
  outreach_count int not null default 0 check (outreach_count >= 0), -- 开发（发出）计数
  read_count int not null default 0 check (read_count >= 0),         -- 阅读（收到回复）计数
  health_score int not null default 50 check (health_score >= 0 and health_score <= 100),
  last_contact_at timestamptz,
  next_followup_at date,
  next_action text not null default '',
  -- 旧站原文时间戳（UTC）与版本
  source_created_at timestamptz,
  source_updated_at timestamptz,
  source_version text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists followup_customers_profile_no_idx
  on public.followup_customers (profile_no) where profile_no <> '';
create unique index if not exists followup_customers_email_idx
  on public.followup_customers (lower(email)) where email <> '';

create table if not exists public.followup_inquiries (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  -- 旧站主键
  profile_no text not null default '',      -- 客户档案编号
  inquiry_no text not null default '',      -- 询盘编号（201 个唯一）
  product_category text not null default '',-- 产品类别（141 条为空）
  product text not null default '',         -- 产品需求
  specs text not null default '',           -- 规格
  quantity text not null default '',
  summary text not null default '',
  -- 旧站原文状态（ verbatim，不由前端改写；前端卡片另由日期 + reply_status 计算）
  stage text not null default '',           -- 当前阶段：新询盘 104 / 需求澄清 37 / 打样中 24 / 已报价 21 / 商务确认 8 / 暂缓 3 / 已关闭 3 / 已成交 1
  reply_status text not null default '',    -- 客户回复状态：已回复·待判断 126 / 未回复·等待客户 67 / 已回复·已处理 8
  reply_snippet text not null default '',   -- 最近回复（原文摘要）
  -- 前端计算用的跟进桶（不从旧站导入，由 app.js 按 下次跟进日期 + stage + reply_status 计算；
  -- 导入脚本也不写这一列，留空即可）
  status text not null default '待处理'
    check (status in ('待处理','今天应跟进','已逾期','等待客户','待定日期','回复待判断','已成交','已丢单','归档')),
  inquiry_date date,                         -- 询盘日期
  first_inquiry_at timestamptz,
  last_reply_at timestamptz,
  last_contact_at timestamptz,              -- 最近联系日期
  next_followup_at date,                    -- 下次跟进日期（15 条为空 = 日期已手动确认“否”）
  next_followup_confirmed boolean not null default false, -- 日期已手动确认（是 186 / 否 15）
  next_action text not null default '',     -- 下一步动作
  notes text not null default '',           -- 询盘备注
  source_created_at timestamptz,
  source_updated_at timestamptz,
  source_version text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists followup_inquiries_inquiry_no_idx
  on public.followup_inquiries (inquiry_no) where inquiry_no <> '';
create index if not exists followup_inquiries_profile_no_idx
  on public.followup_inquiries (profile_no);

-- 询盘跟进历史 / 时间线（310 条：录入询盘 201 / 更新询盘 93 / 客户新回复 8 / 记录联系 8）
create table if not exists public.followup_history (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  inquiry_id uuid references public.followup_inquiries(id) on delete cascade,
  profile_no text not null default '',
  inquiry_no text not null default '',
  record_no text not null default '',       -- 记录编号（310 个唯一，去重键）
  record_type text not null default '',     -- 记录类型
  content text not null default '',         -- 沟通内容
  recorded_at timestamptz,                  -- 记录时间（UTC）
  created_at timestamptz not null default now()
);
create unique index if not exists followup_history_record_no_idx
  on public.followup_history (record_no) where record_no <> '';
create index if not exists followup_history_inquiry_no_idx
  on public.followup_history (inquiry_no);

-- 中文背调（216 条，一客户一行；背调来源 525 条只覆盖 129 位客户）
create table if not exists public.followup_background (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  profile_no text not null default '',
  research_status text not null default '', -- 研究状态
  company_intro_cn text not null default '', -- 公司中文介绍
  business text not null default '',        -- 主营业务
  neoprene_match text not null default '',  -- Neoprene 业务匹配
  unverified_items text not null default '',-- 未核实事项
  researched_at timestamptz,                -- 研究时间（UTC）
  created_at timestamptz not null default now()
);
create unique index if not exists followup_background_profile_no_idx
  on public.followup_background (profile_no) where profile_no <> '';

-- 背调来源（525 条）
create table if not exists public.followup_sources (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  profile_no text not null default '',
  title text not null default '',           -- 来源标题
  url text not null default '',             -- 来源网址
  conclusion text not null default '',      -- 来源支持的结论
  created_at timestamptz not null default now()
);
create index if not exists followup_sources_profile_no_idx
  on public.followup_sources (profile_no);

-- 关联社媒（157 条，覆盖 82 位客户）
create table if not exists public.followup_social (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  profile_no text not null default '',
  platform text not null default '',        -- 平台
  url text not null default '',             -- 主页网址
  link_type text not null default '',       -- 关联类型
  basis text not null default '',           -- 关联依据
  bio text not null default '',             -- 公开简介
  basis_url text not null default '',       -- 依据网址
  record_source text not null default '',   -- 记录来源
  created_at timestamptz not null default now()
);
create index if not exists followup_social_profile_no_idx
  on public.followup_social (profile_no);

-- 官网提取记录（18 条，仅 3 位客户）
create table if not exists public.followup_website_extracts (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  profile_no text not null default '',
  record_type text not null default '',     -- 记录类型
  title_status text not null default '',    -- 标题 / 状态
  content text not null default '',         -- 内容
  source_url text not null default '',      -- 来源网址
  scope text not null default '',           -- 核实范围 / 时间
  created_at timestamptz not null default now()
);
create index if not exists followup_website_extracts_profile_no_idx
  on public.followup_website_extracts (profile_no);

create table if not exists public.followup_emails (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete set null,
  inquiry_id uuid references public.followup_inquiries(id) on delete set null,
  message_id text not null default '',
  thread_id text not null default '',
  in_reply_to text not null default '',
  refs text not null default '',
  direction text not null default 'in' check (direction in ('in','out')),
  from_email text not null default '',
  to_email text not null default '',
  subject text not null default '',
  snippet text not null default '',
  body_text text not null default '',
  sent_at timestamptz,
  intent text not null default 'auto_unknown'
    check (intent in ('auto_unknown','bounce','unsubscribe','reject','demand','quote','sample','price','payment','address','other')),
  intent_confidence text not null default 'low' check (intent_confidence in ('low','high')),
  needs_review boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists followup_emails_message_id_idx
  on public.followup_emails (message_id) where message_id <> '';

create table if not exists public.followup_todos (
  id uuid default gen_random_uuid() primary key,
  customer_id uuid references public.followup_customers(id) on delete cascade,
  inquiry_id uuid references public.followup_inquiries(id) on delete set null,
  reason text not null default '',
  next_action text not null default '',
  due_at date,
  done boolean not null default false,
  -- v3 LaiFaXin 回信自动停：客户一回信，未完成的自动待办由同步/人工确认置 done=true，
  -- 并打 stopped_by_reply=true，以便与人工完成的待办区分开（见 api/sync-email.js）
  stopped_by_reply boolean not null default false,
  fingerprint text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists followup_todos_fingerprint_idx
  on public.followup_todos (fingerprint) where fingerprint <> '';

create table if not exists public.followup_sync_state (
  id int primary key default 1,
  last_sync_at timestamptz,
  last_message_id text not null default '',
  last_error text not null default '',
  provider text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.followup_sync_state (id) values (1)
  on conflict (id) do nothing;

alter table public.followup_customers enable row level security;
alter table public.followup_inquiries enable row level security;
alter table public.followup_history enable row level security;
alter table public.followup_background enable row level security;
alter table public.followup_sources enable row level security;
alter table public.followup_social enable row level security;
alter table public.followup_website_extracts enable row level security;
alter table public.followup_emails enable row level security;
alter table public.followup_todos enable row level security;
alter table public.followup_sync_state enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'followup_customers' and policyname = 'anon all followup customers') then
    create policy "anon all followup customers" on public.followup_customers for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_inquiries' and policyname = 'anon all followup inquiries') then
    create policy "anon all followup inquiries" on public.followup_inquiries for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_history' and policyname = 'anon all followup history') then
    create policy "anon all followup history" on public.followup_history for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_background' and policyname = 'anon all followup background') then
    create policy "anon all followup background" on public.followup_background for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_sources' and policyname = 'anon all followup sources') then
    create policy "anon all followup sources" on public.followup_sources for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_social' and policyname = 'anon all followup social') then
    create policy "anon all followup social" on public.followup_social for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_website_extracts' and policyname = 'anon all followup website extracts') then
    create policy "anon all followup website extracts" on public.followup_website_extracts for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_emails' and policyname = 'anon all followup emails') then
    create policy "anon all followup emails" on public.followup_emails for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_todos' and policyname = 'anon all followup todos') then
    create policy "anon all followup todos" on public.followup_todos for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_sync_state' and policyname = 'anon all followup sync state') then
    create policy "anon all followup sync state" on public.followup_sync_state for all to anon using (true) with check (true);
  end if;
end $$;

-- ============ v3 迁移：LaiFaXin 做法（2026-11-15） ============
-- 若表已按 v2 建好（已部署过），本段把新列补上；若是全新执行，上面的 CREATE TABLE 已含这些列，
-- ADD COLUMN IF NOT EXISTS 会直接跳过。可重复执行，不会报错、不会丢数据。
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'followup_customers'
                 and column_name = 'verification_status') then
    alter table public.followup_customers add column verification_status text not null default 'unverified'
      check (verification_status in ('valid','unknown','invalid','verifying','unverified'));
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'followup_customers'
                 and column_name = 'tags') then
    alter table public.followup_customers add column tags text[] not null default '{}';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'followup_customers'
                 and column_name = 'outreach_count') then
    alter table public.followup_customers add column outreach_count int not null default 0 check (outreach_count >= 0);
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'followup_customers'
                 and column_name = 'read_count') then
    alter table public.followup_customers add column read_count int not null default 0 check (read_count >= 0);
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'followup_todos'
                 and column_name = 'stopped_by_reply') then
    alter table public.followup_todos add column stopped_by_reply boolean not null default false;
  end if;
end $$;

-- ============ 2026-11-16 新增：项目与订单 / 供应商与物流 ============
-- 来源：旧系统项目与订单页（45 条，2025-06-02 至 2026-11-06）与供应商与物流页（10 家），
-- 2026-11-16 由用户登录旧站后只读抄录到 import/old-orders.csv 与 import/old-suppliers.csv；
-- 导入脚本见 import/import-orders-suppliers.py（默认 dry-run，--live 才写库）。
-- 订单与客户的关联只按公司名精确匹配；单名客户（Marta、Molly、Shiv、Christoph Müller、
-- Abdullah）在旧站原文里只有一个人名，照原样存在 customer_company / customer_contact，
-- 不推断公司，匹配不上时 customer_id 留空。
-- 利润口径（见 import/Neoprene_经营汇总_2026_11月.xlsx 的“统计口径”表）：
--   profit_status 待确认 39 / 预计 1 / 已核对 5；待确认的 profit_rmb / profit_rate 留空，
--   绝不填 0——前端也不把待确认利润显示成 0 或数字。

create table if not exists public.followup_orders (
  id uuid default gen_random_uuid() primary key,
  order_no text not null default '',        -- 订单编号（45 个唯一，去重键）
  title text not null default '',           -- 项目 / 产品
  order_date date,                          -- 订单日期（手动填写；利润按此日期归属，非收款日）
  stage text not null default '',           -- 阶段原文：订单确认 / 打样 / 需求/报价 / 采购/生产 / 已出货 / 已完成
                                             -- （含 ·返单 / ·已发货 / ·已签收后缀，如“订单确认·返单”）
  customer_company text not null default '',-- 客户公司原文（单名客户只存人名）
  customer_contact text not null default '',-- 客户联系人
  amount_usd numeric,                       -- 销售总额 USD
  received_usd numeric,                     -- 已收 USD
  exchange_rate numeric,                    -- 本单汇率（每单独立设置）
  cost_rmb numeric,                         -- 已录实际成本 RMB（待确认的订单原文为 0.00，配 cost_note 看）
  cost_note text not null default '',       -- 成本备注（如“5项待确认”“已核对完整”）
  profit_rmb numeric,                       -- 订单利润 RMB（已核对 / 预计才有值；待确认留空）
  profit_rate numeric,                      -- 利润率（百分点数值，如 82.31 表示 82.31%）
  profit_status text not null default '待确认'
    check (profit_status in ('待确认','预计','已核对')),
  customer_id uuid references public.followup_customers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists followup_orders_order_no_idx
  on public.followup_orders (order_no) where order_no <> '';

-- 供应商与物流（10 家：4 家供应商、6 家物流商）
-- 空字段在旧站原文里就是“待补充”/“联系方式待补充”/“联系人待补充”，原样存，不补填。
create table if not exists public.followup_suppliers (
  id uuid default gen_random_uuid() primary key,
  name text not null default '',            -- 伙伴名称（10 个唯一，去重键）
  kind text not null default '供应商'
    check (kind in ('供应商','物流商')),
  contact text not null default '',         -- 联系人
  contact_info text not null default '',    -- 联系方式
  service_or_route text not null default '',-- 材料、服务或物流线路
  detail_count int not null default 0 check (detail_count >= 0), -- 关联费用明细条数
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists followup_suppliers_name_idx
  on public.followup_suppliers (name) where name <> '';

alter table public.followup_orders enable row level security;
alter table public.followup_suppliers enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'followup_orders' and policyname = 'anon all followup orders') then
    create policy "anon all followup orders" on public.followup_orders for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'followup_suppliers' and policyname = 'anon all followup suppliers') then
    create policy "anon all followup suppliers" on public.followup_suppliers for all to anon using (true) with check (true);
  end if;
end $$;
-- ============ 2026-11-21 新增：搜客池（Phase 1，路线 B） ============
-- 来源：~/workspace/your_files/goodjob-adaptation-plan/goodjob-adaptation-plan.pdf
--   第 6-7 页（搜客规则与打分模型、流水线与分工）。只加 4 张表，现有表不动。
-- 定位（用户 2026-11-21 定）：搜客池只收 Excel 名单（不管名单是哪来的），
--   在跟进系统里做清洗 / 去重 / 打分 / 转客户。搜客池不操作来发信、不跑搜索、
--   不验证邮箱——来发信的搜客/验证在另一个聊天里做；这里的“来发信”只是
--   一条名单的来源标签。DeepSeek 自动抓取、批次发起页、自动背调都是 Phase 2/3，
--   本期不做。
-- 打分与硬规则见 app.js 顶部（SCORE_REVIEW_MIN / SCORE_DISCARD_MAX 与
--   checkProspectHardRules / scoreProspect）：硬规则不过直接淘汰，不进打分；
--   100 分打分只按导入的结构化字段算，缺字段那一维记 0，不编造。
-- 部署顺序：先在 Supabase SQL Editor 执行本文件建表，再部署前端；
--   loadAll 会一次性拉 4 张新表，表不存在时整个页面会报加载失败（与 2026-11-16
--   订单/供应商模块同一教训），所以 SQL 必须先行。

-- 搜客批次：一次导入就是一批。原始数 / 淘汰数 / 入池数要对得上账；
--   去重跳过的条数写进 note（如“去重跳过 2 条：域名已存在 1 条，邮箱已存在 1 条”）。
create table if not exists public.prospect_batches (
  id uuid default gen_random_uuid() primary key,
  country text not null default '',          -- 本批国家（可空： mixed 名单按行取国家）
  keyword_group text not null default '',    -- 本批关键词组（如“潜水服 西班牙”）
  source text not null default '手工导入'
    check (source in ('来发信','DeepSeek','手工导入')), -- 只是来源标签，不代表本系统连过它
  run_at timestamptz not null default now(), -- 跑批 / 导入时间
  raw_count int not null default 0 check (raw_count >= 0),         -- 原始行数
  discarded_count int not null default 0 check (discarded_count >= 0), -- 硬规则淘汰 + 去重跳过
  pooled_count int not null default 0 check (pooled_count >= 0),   -- 入池候选数
  note text not null default '',             -- 淘汰 / 去重明细（如去重原因分项）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prospect_batches_created_idx
  on public.prospect_batches (created_at desc);

-- 候选公司：一条就是一家公司。domain 是去重键（含已淘汰的在内，下次再搜到直接跳过）。
-- 联系人主字段在候选行上冗余一份（列表展示与转客户直接用）；全部联系人另存 prospect_contacts。
create table if not exists public.prospect_candidates (
  id uuid default gen_random_uuid() primary key,
  batch_id uuid references public.prospect_batches(id) on delete set null,
  company text not null default '',          -- 公司 / 品牌
  domain text not null default '',           -- 域名（小写去协议去 www；去重键）
  website text not null default '',          -- 官网 URL
  country text not null default '',          -- 国家
  size_min int,                              -- 员工数下限（为空 = 未提供）
  size_max int,                              -- 员工数上限（为空 = 未提供）
  size_text text not null default '',        -- 规模原文（如“11-50 人”）
  evidence_url text not null default '',     -- 证据链接
  evidence_excerpt text not null default '', -- 证据摘录（原文）
  evidence_level text not null default ''
    check (evidence_level in ('site_sale','product_page','blog','image','')),
    -- 证据位置：site_sale 官网明写且有在售产品 / product_page 只在产品页 /
    --   blog 只在博客/新闻 / image 靠图片质感判断（需人工复核）/ '' 未提供
  product_category text not null default '', -- 产品类别（如 潜水服 / 包袋 / 潜水料片材）
  product_line text not null default '',     -- 产品线：片材 / 成品（导入时由类别推断）
  industry text not null default '',         -- 行业（有才填，不编造）
  oem_signal text not null default ''
    check (oem_signal in ('oem','retail','')),
    -- 定制信号：oem 有 custom/OEM/private label/wholesale / retail 只有零售店面 / '' 未提供
  contact_type text not null default ''
    check (contact_type in ('named','generic','none')),
    -- 决策人联系方式：named 具名决策人邮箱 / generic 只有 info@/sales@ 通用邮箱 / none 无邮箱
  score_total int not null default 0 check (score_total >= 0 and score_total <= 100),
  score_evidence int not null default 0,     -- 证据强度（35）
  score_fit int not null default 0,          -- 应用与产品匹配（20）
  score_oem int not null default 0,          -- 定制/OEM 信号（15）
  score_contact int not null default 0,      -- 决策人联系方式（15）
  score_size int not null default 0,         -- 公司规模与活跃度（10）
  score_completeness int not null default 0, -- 联系方式完整度（5）
  needs_human_check boolean not null default false, -- 图片质感判断的候选，需人工复核
  status text not null default '待复核'
    check (status in ('待复核','已保留','已淘汰','已转客户')),
    -- ≥60 待复核 / 40-59 已保留（备选，留池不占待办）/ <40 已淘汰 / 转客户后 已转客户
  discard_reason text not null default '',   -- 淘汰 / 跳过原因（硬规则、去重、<40 都写清）
  verification_status text not null default 'unverified'
    check (verification_status in ('valid','unknown','invalid','verifying','unverified')),
  contact_name text not null default '',      -- 主联系人姓名（冗余）
  contact_role text not null default '',      -- 主联系人职位（冗余）
  contact_email text not null default '',     -- 主联系人邮箱（冗余；转客户用）
  contact_phone text not null default '',     -- 主联系人电话（冗余）
  contact_whatsapp text not null default '',  -- 主联系人 WhatsApp（冗余）
  converted_customer_id uuid references public.followup_customers(id) on delete set null,
  converted_inquiry_id uuid references public.followup_inquiries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 域名唯一（含已淘汰）：同一域名再导进来时前端去重先拦，库里这条是最后一道防线。
create unique index if not exists prospect_candidates_domain_idx
  on public.prospect_candidates (domain) where domain <> '';
create index if not exists prospect_candidates_score_idx
  on public.prospect_candidates (score_total desc, created_at desc);
create index if not exists prospect_candidates_status_idx
  on public.prospect_candidates (status);
create index if not exists prospect_candidates_country_idx
  on public.prospect_candidates (country);

-- 候选联系人：姓名、职位（决策人优先）、邮箱、验证结果、来源。
-- 转客户时并入客户档案联系人（主联系人即候选行上的冗余字段）。
create table if not exists public.prospect_contacts (
  id uuid default gen_random_uuid() primary key,
  candidate_id uuid references public.prospect_candidates(id) on delete cascade,
  name text not null default '',             -- 姓名
  role text not null default '',             -- 职位（决策人优先：Founder/CEO/Owner/采购/产品经理）
  email text not null default '',            -- 邮箱
  phone text not null default '',            -- 电话
  verification_status text not null default 'unverified'
    check (verification_status in ('valid','unknown','invalid','verifying','unverified')),
  source text not null default '',           -- 来源（如 来发信 / 手工导入）
  is_decision_maker boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prospect_contacts_candidate_idx
  on public.prospect_contacts (candidate_id);

-- 覆盖记忆：已搜过的「国家+关键词」组合与已见域名——下一批自动避开，不重复花点数。
-- 同一组合再导入时只提示、不拦截（名单可能更新）；域名去重本身由候选表（含已淘汰）兜底。
create table if not exists public.prospect_coverage (
  id uuid default gen_random_uuid() primary key,
  country text not null default '',          -- 国家
  keyword_group text not null default '',    -- 关键词组
  source text not null default '手工导入',
  domains_seen text[] not null default '{}', -- 该组合下已见过的域名（小写）
  searched_at timestamptz not null default now(), -- 最近一次搜到该组合的时间
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists prospect_coverage_combo_idx
  on public.prospect_coverage (country, keyword_group, source);

alter table public.prospect_batches enable row level security;
alter table public.prospect_candidates enable row level security;
alter table public.prospect_contacts enable row level security;
alter table public.prospect_coverage enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'prospect_batches' and policyname = 'anon all prospect batches') then
    create policy "anon all prospect batches" on public.prospect_batches for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'prospect_candidates' and policyname = 'anon all prospect candidates') then
    create policy "anon all prospect candidates" on public.prospect_candidates for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'prospect_contacts' and policyname = 'anon all prospect contacts') then
    create policy "anon all prospect contacts" on public.prospect_contacts for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'prospect_coverage' and policyname = 'anon all prospect coverage') then
    create policy "anon all prospect coverage" on public.prospect_coverage for all to anon using (true) with check (true);
  end if;
end $$;
