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
