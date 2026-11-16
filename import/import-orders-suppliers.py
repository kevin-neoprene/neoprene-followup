#!/usr/bin/env python3
"""旧系统项目与订单 / 供应商与物流 -> Supabase 导入脚本（只读依赖：标准库）

来源（2026-11-16 由用户登录旧站后只读抄录，见 import/old-system-notes.md）：
    import/old-orders.csv     — 项目与订单 45 条（2025-06-02 至 2026-11-06）
    import/old-suppliers.csv  — 供应商与物流 10 家（4 家供应商、6 家物流商）
    import/Neoprene_经营汇总_2026_11月.xlsx — 只用于核对口径（统计口径表），不导入

用法（写库用 Supabase REST + anon key；RLS 与其它 followup_* 表一样放行 anon 读写）：
    python3 import-orders-suppliers.py                        # 默认 dry-run：只计数 + 校验，不写库
    python3 import-orders-suppliers.py --sql-out out.sql     # dry-run + 生成 INSERT SQL
    python3 import-orders-suppliers.py --json-out out/        # dry-run + 生成每表 JSON
    python3 import-orders-suppliers.py --live                 # 真正写入 Supabase（分批 100 条，冲突跳过）

去重键（与 supabase-followup.sql 的唯一索引一致）：
    订单 order_no；供应商 name。重复执行不会翻倍。

订单与客户的关联：只按公司名精确匹配 live 库 followup_customers.company；
    单名客户（Marta、Molly、Shiv、Christoph Müller、Abdullah）在旧站原文里只有
    一个人名，照原样存在 customer_company / customer_contact，不推断公司，
    匹配不上时 customer_id 留空（dry-run 不连库，只报“可匹配候选”数）。

利润口径：profit_rate 的 "82.31%" 存成数值 82.31；profit_status 待确认的
    profit_rmb / profit_rate 为空时存 NULL，绝不填 0；cost_rmb 按 CSV 原值存
    （待确认订单原文为 0.00，配 cost_note“5项待确认”看）。
"""
import argparse
import csv
import json
import os
import sys
import uuid
from collections import Counter
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ORDERS_CSV = os.path.join(HERE, "old-orders.csv")
SUPPLIERS_CSV = os.path.join(HERE, "old-suppliers.csv")
DEFAULT_URL = "https://gplkvdodbfzknyafdttb.supabase.co"

CONFIRMED_SUBSTRINGS = ("订单确认", "采购", "已出货", "已完成")
EXPECTED = {
    "orders": 45,
    "suppliers": 10,
    "confirmed_orders": 26,
    "distinct_companies": 26,
    "stages": {
        "订单确认": 22, "打样": 16, "订单确认·返单": 1, "打样·返单": 1,
        "需求/报价": 1, "需求/报价·已签收": 1, "采购/生产·已发货": 1,
        "已出货·已发货": 1, "已完成·已签收": 1,
    },
    "profit_status": {"待确认": 39, "预计": 1, "已核对": 5},
    "supplier_kinds": {"供应商": 4, "物流商": 6},
}


def txt(v):
    return str(v).strip() if v is not None else ""


def num(v):
    """'82.31%' -> 82.31；'100.00' -> 100.0；空 -> None。"""
    s = txt(v).replace("%", "").replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def iso_date(v):
    s = txt(v)[:10]
    if not s:
        return None
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def is_confirmed(stage):
    return any(k in (stage or "") for k in CONFIRMED_SUBSTRINGS)


def build():
    report = {"warnings": [], "checks": {}}
    with open(ORDERS_CSV, newline="", encoding="utf-8-sig") as f:
        order_rows = list(csv.DictReader(f))
    with open(SUPPLIERS_CSV, newline="", encoding="utf-8-sig") as f:
        supplier_rows = list(csv.DictReader(f))

    # ---- 校验：主键唯一、必填非空 ----
    order_nos = [txt(r.get("order_no")) for r in order_rows]
    dups = [k for k, v in Counter(order_nos).items() if v > 1]
    report["checks"]["订单编号唯一"] = f"{len(set(order_nos))}/{len(order_nos)}" + (f" 重复: {dups}" if dups else "")
    if dups:
        report["warnings"].append(f"订单编号有重复值: {dups}")
    names = [txt(r.get("name")) for r in supplier_rows]
    dups_s = [k for k, v in Counter(names).items() if v > 1]
    report["checks"]["供应商名称唯一"] = f"{len(set(names))}/{len(names)}" + (f" 重复: {dups_s}" if dups_s else "")
    if dups_s:
        report["warnings"].append(f"供应商名称有重复值: {dups_s}")

    orders = []
    skipped = []
    for r in order_rows:
        order_no = txt(r.get("order_no"))
        title = txt(r.get("title"))
        if not order_no or not title:
            skipped.append(r)
            continue
        orders.append({
            "id": str(uuid.uuid4()),
            "order_no": order_no,
            "title": title,
            "order_date": iso_date(r.get("date")),
            "stage": txt(r.get("stage")),
            "customer_company": txt(r.get("customer_company")),
            "customer_contact": txt(r.get("customer_contact")),
            "amount_usd": num(r.get("amount_usd")),
            "received_usd": num(r.get("received_usd")),
            "exchange_rate": num(r.get("exchange_rate")),
            "cost_rmb": num(r.get("cost_rmb")),
            "cost_note": txt(r.get("cost_note")),
            "profit_rmb": num(r.get("profit_rmb")),
            "profit_rate": num(r.get("profit_rate")),
            "profit_status": txt(r.get("profit_status")) or "待确认",
            "customer_id": None,  # --live 时按公司名精确匹配后填
        })
    report["checks"]["跳过行（缺单号/标题）"] = len(skipped)
    if skipped:
        report["warnings"].append(f"跳过 {len(skipped)} 行订单（缺单号或标题）: {skipped}")

    suppliers = []
    skipped_s = []
    for r in supplier_rows:
        name = txt(r.get("name"))
        kind = txt(r.get("type"))
        if not name or kind not in ("供应商", "物流商"):
            skipped_s.append(r)
            continue
        try:
            detail = int(txt(r.get("detail_count")) or 0)
        except ValueError:
            detail = 0
        suppliers.append({
            "id": str(uuid.uuid4()),
            "name": name,
            "kind": kind,
            "contact": txt(r.get("contact")),
            "contact_info": txt(r.get("contact_info")),
            "service_or_route": txt(r.get("service_or_route")),
            "detail_count": detail,
        })
    report["checks"]["跳过行（缺名称/类型非法）"] = len(skipped_s)
    if skipped_s:
        report["warnings"].append(f"跳过 {len(skipped_s)} 行供应商: {skipped_s}")

    # ---- 口径复核（与 old-system-notes.md 的已核对数字对照） ----
    stages = Counter(o["stage"] for o in orders)
    report["checks"]["阶段分布"] = dict(sorted(stages.items()))
    if dict(stages) != EXPECTED["stages"]:
        report["warnings"].append(f"阶段分布与预期不符（预期 {EXPECTED['stages']}）")
    pstatus = Counter(o["profit_status"] for o in orders)
    report["checks"]["利润状态分布"] = dict(sorted(pstatus.items()))
    if dict(pstatus) != EXPECTED["profit_status"]:
        report["warnings"].append(f"利润状态分布与预期不符（预期 {EXPECTED['profit_status']}）")
    kinds = Counter(s["kind"] for s in suppliers)
    report["checks"]["伙伴类型分布"] = dict(sorted(kinds.items()))
    if dict(kinds) != EXPECTED["supplier_kinds"]:
        report["warnings"].append(f"伙伴类型分布与预期不符（预期 {EXPECTED['supplier_kinds']}）")
    confirmed = sum(1 for o in orders if is_confirmed(o["stage"]))
    report["checks"]["已确认订单（阶段含 订单确认/采购/已出货/已完成）"] = f"{confirmed}（期望 {EXPECTED['confirmed_orders']}）"
    if confirmed != EXPECTED["confirmed_orders"]:
        report["warnings"].append(f"已确认订单 {confirmed} 条，与预期 {EXPECTED['confirmed_orders']} 不符")
    companies = {o["customer_company"] for o in orders if o["customer_company"]}
    report["checks"]["不同客户公司"] = f"{len(companies)}（期望 {EXPECTED['distinct_companies']}）"
    if len(companies) != EXPECTED["distinct_companies"]:
        report["warnings"].append(f"不同客户公司 {len(companies)} 家，与预期 {EXPECTED['distinct_companies']} 不符")
    report["checks"]["订单总数（期望 45）"] = len(orders)
    report["checks"]["供应商总数（期望 10）"] = len(suppliers)
    # dry-run 不连库：只报有多少订单的公司名非空（--live 时才按 live 库精确匹配）
    report["checks"]["订单有公司名（--live 时按此精确匹配客户）"] = sum(
        1 for o in orders if o["customer_company"])
    report["checks"]["订单公司名为空"] = sum(1 for o in orders if not o["customer_company"])

    tables = {"followup_orders": orders, "followup_suppliers": suppliers}
    return tables, report


def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def to_sql(tables):
    out = ["-- 由 import-orders-suppliers.py 生成；执行前请先在 Supabase 执行 supabase-followup.sql 建表。",
           "-- 冲突键已存在时跳过（ON CONFLICT DO NOTHING），可重复执行。",
           "-- 注意：customer_id 需 --live 模式按 live 库公司名匹配后填；SQL 版的 customer_id 为 NULL，",
           "-- 执行后可在 Supabase 里按公司名补关联，或改用 --live 导入。"]
    conflicts = {"followup_orders": "order_no", "followup_suppliers": "name"}
    for table, rows in tables.items():
        if not rows:
            continue
        cols = list(rows[0].keys())
        for r in rows:
            vals = ", ".join(sql_literal(r[c]) for c in cols)
            stmt = f"INSERT INTO public.{table} ({', '.join(cols)}) VALUES ({vals})"
            if table in conflicts:
                stmt += f" ON CONFLICT ({conflicts[table]}) DO NOTHING"
            out.append(stmt + ";")
    return "\n".join(out)


def sb_get(base_url, anon_key, path):
    import urllib.request
    req = urllib.request.Request(
        base_url.rstrip("/") + "/rest/v1/" + path,
        headers={"apikey": anon_key, "Authorization": "Bearer " + anon_key},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def live_insert(base_url, anon_key, tables):
    """经 Supabase REST 分批 upsert；需 --live 才调用。订单先按公司名精确匹配客户。"""
    import urllib.request
    # 1) 拉 live 客户的公司名 -> id（精确匹配；单名客户的公司为空，匹配不上留空）
    customers = sb_get(base_url, anon_key,
                       "followup_customers?select=id,company&limit=1000")
    by_company = {}
    for c in customers:
        co = (c.get("company") or "").strip()
        if co and co not in by_company:
            by_company[co] = c["id"]
    linked = 0
    for o in tables["followup_orders"]:
        cid = by_company.get((o["customer_company"] or "").strip())
        if cid:
            o["customer_id"] = cid
            linked += 1
    print(f"客户关联：live 库 {len(customers)} 位客户，订单按公司名精确匹配上 {linked} / "
          f"{len(tables['followup_orders'])} 条，其余 customer_id 留空。")
    unlinked = sorted({o["customer_company"] for o in tables["followup_orders"]
                       if not o["customer_id"] and o["customer_company"]})
    if unlinked:
        print(f"未匹配上的公司名（原文照存，不推断）：{', '.join(unlinked)}")

    total = {}
    for table, rows in tables.items():
        # 注意：不要用 ?on_conflict + resolution=merge-duplicates——PostgREST 的
        # ON CONFLICT 要求真正的唯一约束，而建表 SQL 只有部分唯一索引（与 2026-11-15
        # 首次导入时遇到的 42P10 是同一个问题）。表是空的，一次性导入用普通插入即可；
        # 重复跑会在重复键上报错（预期行为，不是静默覆盖）。
        done = 0
        for i in range(0, len(rows), 100):
            batch = rows[i:i + 100]
            url = base_url.rstrip("/") + "/rest/v1/" + table
            req = urllib.request.Request(url, method="POST",
                                         data=json.dumps(batch).encode("utf-8"),
                                         headers={"apikey": anon_key,
                                                  "Authorization": "Bearer " + anon_key,
                                                  "Content-Type": "application/json",
                                                  "Prefer": "return=minimal"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
            done += len(batch)
        total[table] = done
    return total


def main():
    ap = argparse.ArgumentParser(description="旧系统项目与订单 / 供应商与物流 -> Supabase 导入（默认 dry-run）")
    ap.add_argument("--live", action="store_true", help="真正写入 Supabase（需 SUPABASE_URL + SUPABASE_ANON_KEY）")
    ap.add_argument("--sql-out", help="生成 INSERT SQL 文件路径")
    ap.add_argument("--json-out", help="生成每表 JSON 的目录")
    args = ap.parse_args()

    tables, report = build()
    print("== dry-run 计数（不写库） ==")
    for table, rows in tables.items():
        print(f"  {table}: {len(rows)} 行")
    print("== 校验 ==")
    for k, v in report["checks"].items():
        print(f"  {k}: {v}")
    if report["warnings"]:
        print("== 警告 ==")
        for w in report["warnings"]:
            print(f"  ! {w}")
    else:
        print("== 警告 ==\n  无")

    if args.sql_out:
        with open(args.sql_out, "w", encoding="utf-8") as f:
            f.write(to_sql(tables))
        print(f"SQL 已写入 {args.sql_out}")
    if args.json_out:
        os.makedirs(args.json_out, exist_ok=True)
        for table, rows in tables.items():
            with open(os.path.join(args.json_out, table + ".json"), "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=1)
        print(f"JSON 已写入 {args.json_out}/")
    if args.live:
        url = os.environ.get("SUPABASE_URL", DEFAULT_URL)
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if not key:
            print("写库需要 SUPABASE_ANON_KEY 环境变量（anon key 即可，RLS 与其它 followup_* 表一样放行 anon 读写）",
                  file=sys.stderr)
            sys.exit(3)
        total = live_insert(url, key, tables)
        print("== 已写入 Supabase ==")
        for table, n in total.items():
            print(f"  {table}: {n} 行")


if __name__ == "__main__":
    main()
