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
