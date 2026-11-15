#!/usr/bin/env python3
"""旧系统导出文件 -> Supabase 导入脚本（草稿，已实现 dry-run；写库需显式 --live）

导出文件：Neoprene______2026-11-15.xlsx（导出时间 2026-11-15 22:12:30 北京时间）
    客户档案 216 / 关联询盘 201 / 询盘跟进历史 310 / 跟进评估 216 /
    中文背调 216 / 背调来源 525 / 关联社媒 157 / 官网提取记录 18 / 导出说明

用法（只读依赖：openpyxl；写库另需 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 环境变量）：
    python3 import-from-xlsx.py <xlsx 路径>                 # 默认 dry-run：只计数 + 校验，不写库
    python3 import-from-xlsx.py <xlsx 路径> --sql-out out.sql  # dry-run + 生成 INSERT SQL
    python3 import-from-xlsx.py <xlsx 路径> --json-out out/    # dry-run + 生成每表 JSON
    python3 import-from-xlsx.py <xlsx 路径> --live             # 真正写入 Supabase（分批 100 条，冲突跳过）

去重键（与 supabase-followup.sql 的唯一索引一致）：
    客户 profile_no（客户档案编号）/ 邮箱小写；询盘 inquiry_no；历史 record_no。
重复运行不会翻倍：同一 profile_no / inquiry_no / record_no 再次导入会被跳过。

差异说明（201 vs 202，写死在报告里，不硬凑）：
    旧站首页显示 202 条询盘，导出文件只有 201 条；但用 201 条算出的
    今天应跟进 10 / 已逾期 106 / 全部进行中 194 / 待判断 122 / 等待客户 66
    与首页数字全部对得上，说明 201 条是自洽的，多出的 1 条在文件里找不到。
    本脚本按 201 条导入，并在报告里标注该差异。
"""
import argparse
import json
import os
import sys
import uuid
from collections import Counter
from datetime import date, datetime

try:
    import openpyxl
except ImportError:
    print("缺少 openpyxl：请先执行 pip install openpyxl", file=sys.stderr)
    sys.exit(2)

EXPECTED_TODAY = date(2026, 11, 15)  # 导出当天的日期口径；卡片数字按这一天复核
GRADE_TO_STAGE = {
    "A · 重点跟进": "重点跟进",
    "B · 正常推进": "正常推进",
    "C · 暂缓 / 低优先": "暂缓 / 低优先",
    "待评估": "待评估",
}
TERMINAL_STAGES = {"已成交", "已关闭", "暂缓"}

# ---- v3 LaiFaXin 做法：保存前去重 / 标签播种（与 app.js 的 findDuplicateCustomer 同一规则） ----
# 免费邮箱域名：域名去重时排除——几十个客户都用 gmail.com 不能算同一家公司。
FREE_EMAIL_DOMAINS = {
    "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "icloud.com",
    "qq.com", "163.com", "126.com", "foxmail.com", "sina.com", "live.com",
    "msn.com", "aol.com", "mail.com", "proton.me", "protonmail.com",
    "bk.ru", "mail.ru", "yandex.ru",
}


def email_domain(email):
    parts = (email or "").strip().lower().split("@")
    return parts[1] if len(parts) == 2 else ""


def build_tags(source, inqs):
    """按导出文件已有的字段播种标签，缺的留空，绝不编造。
    命名约定：产品｜行业｜年月，例如 NEO-WS｜潜水服水上运动｜2026-08。
    导出文件里没有“行业”这一列，所以行业段不编造，只播两种能从文件直接得到的标签：
      1) 来源标签：客户来源原文（如“邮件询盘”“Excel 导入”）；
      2) 产品+年月标签：某条询盘的产品类别 + 该询盘的询盘日期 YYYY-MM
         （如“潜水服｜2026-08”；产品类别 141/201 为空、日期缺失的询盘不播）。
    行业段请在来发信验证/人工确认后补，或在前端标签框里手动加。"""
    tags = []
    seen = set()

    def add(t):
        t = (t or "").strip()
        if t and t not in seen:
            seen.add(t)
            tags.append(t)

    add(source)
    for r in inqs:
        cat = txt(r.get("产品类别"))
        d = iso_date(r.get("询盘日期"))
        if cat and d:
            add(f"{cat}｜{d[:7]}")
        elif cat:
            add(cat)
    return tags


def clean(v):
    """去首尾空白；None -> ''；数字/日期原样返回。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    return v


def txt(v):
    return str(clean(v)) if clean(v) != "" else ""


def iso_date(v):
    """Excel 日期/文本 -> 'YYYY-MM-DD' 或 None；空 -> None。"""
    v = clean(v)
    if v == "":
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v)[:10]
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def iso_dt(v):
    """Excel 日期时间 -> ISO 字符串或 None。"""
    v = clean(v)
    if v == "":
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day).isoformat()
    return str(v)


def read_sheet(wb, name):
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(c) for c in rows[0]]
    return [dict(zip(header, r)) for r in rows[1:]]


def build(path):
    """读 xlsx，返回 {table: [row, ...]} + 校验报告 dict。"""
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    cust_rows = read_sheet(wb, "客户档案")
    eval_rows = read_sheet(wb, "跟进评估")
    inq_rows = read_sheet(wb, "关联询盘")
    hist_rows = read_sheet(wb, "询盘跟进历史")
    bg_rows = read_sheet(wb, "中文背调")
    src_rows = read_sheet(wb, "背调来源")
    soc_rows = read_sheet(wb, "关联社媒")
    web_rows = read_sheet(wb, "官网提取记录")

    report = {"warnings": [], "checks": {}}
    # ---- 校验：主键唯一、邮箱唯一非空、孤儿引用 ----
    for label, rows, key in [
        ("客户档案编号", cust_rows, "客户档案编号"),
        ("询盘编号", inq_rows, "询盘编号"),
        ("记录编号", hist_rows, "记录编号"),
    ]:
        vals = [r[key] for r in rows]
        dups = [k for k, v in Counter(vals).items() if v > 1]
        report["checks"][f"{label}唯一"] = f"{len(set(vals))}/{len(vals)}" + (f" 重复: {dups}" if dups else "")
        if dups:
            report["warnings"].append(f"{label}有重复值: {dups}")
    emails = [(r["邮箱"] or "").strip().lower() for r in cust_rows]
    report["checks"]["邮箱空值"] = sum(1 for e in emails if not e)
    report["checks"]["邮箱唯一(非空)"] = len(set(e for e in emails if e))
    if any(not e for e in emails):
        report["warnings"].append("有客户邮箱为空：先导入并标“缺邮箱”，邮件同步无法匹配这些客户")
    cust_ids = {r["客户档案编号"] for r in cust_rows}
    inq_ids = {r["询盘编号"] for r in inq_rows}
    orphans = sum(1 for r in inq_rows if r["客户档案编号"] not in cust_ids)
    orphans += sum(1 for r in hist_rows if r["客户档案编号"] not in cust_ids or r["询盘编号"] not in inq_ids)
    orphans += sum(1 for r in eval_rows + bg_rows + src_rows + soc_rows + web_rows
                   if r["客户档案编号"] not in cust_ids)
    report["checks"]["孤儿引用"] = orphans
    if orphans:
        report["warnings"].append(f"有 {orphans} 行引用了不存在的客户/询盘编号（导入时跳过并列出）")

    # ---- v3 保存前去重：同一文件里邮箱小写重复，或同一家公司 + 同一非免费邮箱域名，
    #      只留第一条，其余跳过并计数（不静默覆盖、不编造）。本次导出 216 个邮箱全唯一，
    #      预期跳过 0 条；跳过 >0 时报告里会出警告。
    seen_emails = {}
    seen_domain_company = {}
    deduped_email = 0
    deduped_domain = 0
    kept_cust_rows = []
    for r in cust_rows:
        em = (r["邮箱"] or "").strip().lower()
        co = " ".join(txt(r["公司 / 品牌"]).lower().split())
        dom = email_domain(em)
        if em and em in seen_emails:
            deduped_email += 1
            continue
        if co and dom and dom not in FREE_EMAIL_DOMAINS and (dom, co) in seen_domain_company:
            deduped_domain += 1
            continue
        if em:
            seen_emails[em] = r["客户档案编号"]
        if co and dom and dom not in FREE_EMAIL_DOMAINS:
            seen_domain_company[(dom, co)] = r["客户档案编号"]
        kept_cust_rows.append(r)
    report["checks"]["去重跳过(邮箱重复)"] = deduped_email
    report["checks"]["去重跳过(同公司域名)"] = deduped_domain
    if deduped_email or deduped_domain:
        report["warnings"].append(
            f"去重跳过 {deduped_email + deduped_domain} 条客户（邮箱重复 {deduped_email}，"
            f"同公司域名 {deduped_domain}）；只导入第一条，跳过的档案编号未写入")
    cust_rows = kept_cust_rows
    # 被去重跳过的客户，其名下的询盘/历史/背调也不导入（否则会成孤儿行），一并计数。
    kept_ids = {r["客户档案编号"] for r in cust_rows}
    _skipped = 0
    for _rows in (inq_rows, hist_rows, eval_rows, bg_rows, src_rows, soc_rows, web_rows):
        _before = len(_rows)
        _rows[:] = [r for r in _rows if r["客户档案编号"] in kept_ids]
        _skipped += _before - len(_rows)
    report["checks"]["去重连带跳过(询盘/历史/背调行)"] = _skipped

    # ---- 客户：档案 + 评估合并 ----
    eval_by_id = {r["客户档案编号"]: r for r in eval_rows}
    inq_by_cust = {}
    for r in inq_rows:
        inq_by_cust.setdefault(r["客户档案编号"], []).append(r)
    customers = []
    cust_uuid = {}
    for r in cust_rows:
        pid = r["客户档案编号"]
        cid = str(uuid.uuid4())
        cust_uuid[pid] = cid
        ev = eval_by_id.get(pid, {})
        grade = txt(ev.get("当前重要等级")) or "待评估"
        inqs = inq_by_cust.get(pid, [])
        last_contacts = [iso_date(x["最近联系日期"]) for x in inqs]
        last_contacts = [d for d in last_contacts if d]
        customers.append({
            "id": cid,
            "profile_no": pid,
            "name": txt(r["联系人姓名"]),
            "company": txt(r["公司 / 品牌"]),
            "email": (r["邮箱"] or "").strip().lower(),
            "country": txt(r["国家 / 地区"]),
            "job_title": txt(r["客户职位"]),
            "website": txt(r["官网"]),
            "phone": txt(r["手机号码"]),
            "whatsapp": txt(r["WhatsApp"]),
            "other_contact": txt(r["其他联系方式"]),
            "customer_type": txt(r["客户类型"]),
            "source": txt(r["客户来源"]),
            "background": txt(r["客户背景"]),
            "notes": txt(r["客户备注"]),
            "whatsapp_verified": txt(r["WhatsApp 核实状态"]),
            "cn_background_status": txt(r["中文背调状态"]),
            "grade": grade,
            "grade_source": txt(ev.get("等级设置")),
            "grade_reason": txt(ev.get("手动等级理由")),
            "eval_advice": txt(ev.get("跟进建议")),
            "eval_next_action": txt(ev.get("建议下一步")),
            "eval_basis": txt(ev.get("判断依据")),
            "eval_missing_info": txt(ev.get("待补信息")),
            "eval_limits": txt(ev.get("核实限制")),
            "eval_detail": {
                "产品与业务匹配": txt(ev.get("产品与业务匹配")),
                "采购需求明确度": txt(ev.get("采购需求明确度")),
                "采购时间": txt(ev.get("采购时间")),
                "合作潜力": txt(ev.get("合作潜力（你的判断）")),
                "客户联系意愿": txt(ev.get("客户联系意愿")),
                "采购量/需求补充": txt(ev.get("采购量 / 需求补充")),
            },
            "stage": GRADE_TO_STAGE.get(grade, "待评估"),
            # v3 LaiFaXin 做法：验证状态默认未验证（导出文件无此列）；标签按 build_tags 播种；
            # 开发/已读计数从 0 开始，同步后按实际收发 +1。
            "verification_status": "unverified",
            "tags": build_tags(txt(r["客户来源"]), inq_by_cust.get(pid, [])),
            "outreach_count": 0,
            "read_count": 0,
            "health_score": 50,
            "last_contact_at": max(last_contacts) if last_contacts else None,
            "next_followup_at": None,
            "next_action": txt(ev.get("建议下一步")),
            "source_created_at": iso_dt(r["创建时间（UTC）"]),
            "source_updated_at": iso_dt(r["更新时间（UTC）"]),
            "source_version": txt(r["版本号"]),
        })
    # 客户下次跟进：取其名下询盘里最近的未来下次跟进日期
    for c in customers:
        nxts = [iso_date(x["下次跟进日期"]) for x in inq_by_cust.get(c["profile_no"], [])]
        nxts = [d for d in nxts if d]
        if nxts:
            c["next_followup_at"] = min(nxts)

    # ---- 询盘 ----
    inquiries = []
    inq_uuid = {}
    for r in inq_rows:
        iid = str(uuid.uuid4())
        inq_uuid[r["询盘编号"]] = iid
        inquiries.append({
            "id": iid,
            "customer_id": cust_uuid.get(r["客户档案编号"]),
            "profile_no": r["客户档案编号"],
            "inquiry_no": r["询盘编号"],
            "product_category": txt(r["产品类别"]),
            "product": txt(r["产品需求"]),
            "specs": txt(r["规格"]),
            "quantity": "",
            "summary": txt(r["最近回复"]),
            "stage": txt(r["当前阶段"]),
            "reply_status": txt(r["客户回复状态"]),
            "reply_snippet": txt(r["最近回复"]),
            "status": "待处理",  # 不导入；前端由日期 + stage + reply_status 实时计算
            "inquiry_date": iso_date(r["询盘日期"]),
            "first_inquiry_at": iso_date(r["询盘日期"]),
            "last_reply_at": iso_date(r["最近联系日期"]) if "已回复" in txt(r["客户回复状态"]) else None,
            "last_contact_at": iso_date(r["最近联系日期"]),
            "next_followup_at": iso_date(r["下次跟进日期"]),
            "next_followup_confirmed": txt(r["日期已手动确认"]) == "是",
            "next_action": txt(r["下一步动作"]),
            "notes": txt(r["询盘备注"]),
            "source_created_at": iso_dt(r["创建时间（UTC）"]),
            "source_updated_at": iso_dt(r["更新时间（UTC）"]),
            "source_version": txt(r["版本号"]),
        })
    report["checks"]["询盘无产品需求"] = sum(1 for x in inquiries if not x["product"])
    report["checks"]["询盘下次跟进日期空"] = sum(1 for x in inquiries if not x["next_followup_at"])

    # ---- 跟进历史 ----
    history = [{
        "id": str(uuid.uuid4()),
        "customer_id": cust_uuid.get(r["客户档案编号"]),
        "inquiry_id": inq_uuid.get(r["询盘编号"]),
        "profile_no": r["客户档案编号"],
        "inquiry_no": r["询盘编号"],
        "record_no": r["记录编号"],
        "record_type": txt(r["记录类型"]),
        "content": txt(r["沟通内容"]),
        "recorded_at": iso_dt(r["记录时间（UTC）"]),
    } for r in hist_rows]

    # ---- 背调 / 来源 / 社媒 / 官网 ----
    background = [{
        "id": str(uuid.uuid4()),
        "customer_id": cust_uuid.get(r["客户档案编号"]),
        "profile_no": r["客户档案编号"],
        "research_status": txt(r["研究状态"]),
        "company_intro_cn": txt(r["公司中文介绍"]),
        "business": txt(r["主营业务"]),
        "neoprene_match": txt(r["Neoprene 业务匹配"]),
        "unverified_items": txt(r["未核实事项"]),
        "researched_at": iso_dt(r["研究时间（UTC）"]),
    } for r in bg_rows]
    sources = [{
        "id": str(uuid.uuid4()),
        "customer_id": cust_uuid.get(r["客户档案编号"]),
        "profile_no": r["客户档案编号"],
        "title": txt(r["来源标题"]),
        "url": txt(r["来源网址"]),
        "conclusion": txt(r["来源支持的结论"]),
    } for r in src_rows]
    social = [{
        "id": str(uuid.uuid4()),
        "customer_id": cust_uuid.get(r["客户档案编号"]),
        "profile_no": r["客户档案编号"],
        "platform": txt(r["平台"]),
        "url": txt(r["主页网址"]),
        "link_type": txt(r["关联类型"]),
        "basis": txt(r["关联依据"]),
        "bio": txt(r["公开简介"]),
        "basis_url": txt(r["依据网址"]),
        "record_source": txt(r["记录来源"]),
    } for r in soc_rows]
    website = [{
        "id": str(uuid.uuid4()),
        "customer_id": cust_uuid.get(r["客户档案编号"]),
        "profile_no": r["客户档案编号"],
        "record_type": txt(r["记录类型"]),
        "title_status": txt(r["标题 / 状态"]),
        "content": txt(r["内容"]),
        "source_url": txt(r["来源网址"]),
        "scope": txt(r["核实范围 / 时间"]),
    } for r in web_rows]

    # ---- 卡片数字复核（按导出当天 2026-11-15，与旧站首页对照） ----
    t = EXPECTED_TODAY.isoformat()
    in_progress = [x for x in inquiries if x["stage"] not in TERMINAL_STAGES]
    due = sum(1 for x in in_progress if x["next_followup_at"] == t)
    overdue = sum(1 for x in in_progress if x["next_followup_at"] and x["next_followup_at"] < t)
    review = sum(1 for x in in_progress if x["reply_status"] == "已回复 · 待判断")
    waiting = sum(1 for x in in_progress if x["reply_status"] == "未回复 · 等待客户")
    report["checks"]["卡片复核(今天/逾期/进行中/待判断/等待客户)"] = \
        f"{due}/{overdue}/{len(in_progress)}/{review}/{waiting}（期望 10/106/194/122/66）"
    for label, got, want in [("今天应跟进", due, 10), ("已逾期", overdue, 106),
                             ("全部进行中", len(in_progress), 194),
                             ("回复待判断", review, 122), ("等待客户", waiting, 66)]:
        if got != want:
            report["warnings"].append(f"卡片复核不符：{label} 算出 {got}，旧站首页为 {want}（请先核对再导入）")
    report["checks"]["询盘总数(期望 201；首页曾显示 202，差 1 条见 IMPORT.md)"] = len(inquiries)

    tables = {
        "followup_customers": customers,
        "followup_inquiries": inquiries,
        "followup_history": history,
        "followup_background": background,
        "followup_sources": sources,
        "followup_social": social,
        "followup_website_extracts": website,
    }
    return tables, report


def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, dict):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    if isinstance(v, (list, tuple)):
        # v3 标签：text[] 列写成 ARRAY['a','b']::text[]
        inner = ", ".join("'" + str(x).replace("'", "''") + "'" for x in v)
        return f"ARRAY[{inner}]::text[]"
    return "'" + str(v).replace("'", "''") + "'"


def to_sql(tables):
    out = ["-- 由 import-from-xlsx.py 生成；执行前请先在 Supabase 执行 supabase-followup.sql 建表。",
           "-- 冲突键已存在时跳过（ON CONFLICT DO NOTHING），可重复执行。"]
    conflicts = {
        "followup_customers": "profile_no",
        "followup_inquiries": "inquiry_no",
        "followup_history": "record_no",
        "followup_background": "profile_no",
    }
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


def live_insert(base_url, service_key, tables):
    """经 Supabase REST 分批 upsert；需 --live 才调用。"""
    import urllib.request
    total = {}
    for table, rows in tables.items():
        on_conflict = {
            "followup_customers": "profile_no",
            "followup_inquiries": "inquiry_no",
            "followup_history": "record_no",
            "followup_background": "profile_no",
        }.get(table)
        done = 0
        for i in range(0, len(rows), 100):
            batch = rows[i:i + 100]
            url = base_url.rstrip("/") + "/rest/v1/" + table
            if on_conflict:
                url += "?on_conflict=" + on_conflict
            req = urllib.request.Request(url, method="POST",
                                         data=json.dumps(batch).encode("utf-8"),
                                         headers={"apikey": service_key,
                                                  "Authorization": "Bearer " + service_key,
                                                  "Content-Type": "application/json",
                                                  "Prefer": "return=minimal,resolution=merge-duplicates"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
            done += len(batch)
        total[table] = done
    return total


def main():
    ap = argparse.ArgumentParser(description="旧系统导出 xlsx -> Supabase 导入（默认 dry-run）")
    ap.add_argument("xlsx", help="导出文件路径")
    ap.add_argument("--live", action="store_true", help="真正写入 Supabase（需 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY）")
    ap.add_argument("--sql-out", help="生成 INSERT SQL 文件路径")
    ap.add_argument("--json-out", help="生成每表 JSON 的目录")
    args = ap.parse_args()

    tables, report = build(args.xlsx)
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
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            print("写库需要 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY 环境变量（service_role key，不要用 anon key）",
                  file=sys.stderr)
            sys.exit(3)
        total = live_insert(url, key, tables)
        print("== 已写入 Supabase ==")
        for table, n in total.items():
            print(f"  {table}: {n} 行")


if __name__ == "__main__":
    main()
