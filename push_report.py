#!/usr/bin/env python3
"""
push_report.py
==============
讀取 exportReportJSON() 產生的 report_*.json，
在 Notion 建立（或複用）「檢查報告」資料庫，新增一筆完整明細。

使用方式：
    直接執行 push_report.bat（雙擊），腳本會自動選最新的 report_*.json
    或手動：python push_report.py report_2026-04-29T10-30-00.json
"""

import io, json, sys, os, glob, urllib.request, urllib.error
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ─── 設定 ──────────────────────────────────────────────────────────────────
TOKEN    = "ntn_Y36273413268N3qINTubBtDxXTJUiBSr3w36Il3SNaK29v"
DB_ID    = "bc49a5edcbef4dd1b0ce16a3b52d8b6c"   # 原檢查項目資料庫
VER      = "2022-06-28"
SCRIPT_DIR = Path(__file__).parent

# ── 手動指定父頁面（選填）────────────────────────────────────────────────
# 若自動偵測失敗，在此填入你要放報告資料庫的 Notion 頁面 ID
# 取得方式：在 Notion 打開目標頁面 → 複製頁面連結 → 取最後一段 32 碼
# 例：https://www.notion.so/YourTitle-3460d834d60e818a... → 3460d834d60e818a...
# 記得該頁面也要在 Connections 加入 MEP Sync！
REPORT_PARENT_PAGE_ID = ""   # 留空 = 自動偵測

# 報告資料庫的 ID 快取（避免每次重建）
REPORT_DB_CACHE = SCRIPT_DIR / ".report_db_id"

# ─── Notion API ────────────────────────────────────────────────────────────
def notion_req(method, path, body=None):
    url  = f"https://api.notion.com/v1{path}"
    hdrs = {
        "Authorization":  f"Bearer {TOKEN}",
        "Notion-Version": VER,
        "Content-Type":   "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req  = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f"  ❌ HTTP {e.code}: {err[:300]}")
        return None

# ─── 取得原資料庫的父頁面 ID ──────────────────────────────────────────────
def get_parent_page_id():
    data = notion_req("GET", f"/databases/{DB_ID}")
    if not data:
        print("❌ 無法取得原資料庫資訊")
        sys.exit(1)
    parent = data.get("parent", {})
    ptype  = parent.get("type", "")

    if ptype == "page_id":
        # 資料庫直接掛在某個頁面下
        return parent["page_id"]
    elif ptype == "block_id":
        # 資料庫嵌入在頁面的 block 內，block_id 即為該頁面 ID
        return parent["block_id"]
    elif ptype == "workspace":
        # 資料庫在 workspace 根層，報告庫也建在根層
        return None
    else:
        print(f"⚠️  未知父層類型：{ptype}，將建在 workspace 根層")
        return None

# ─── 建立報告資料庫（第一次才執行）───────────────────────────────────────
def create_report_db(parent_page_id):
    print("📦 建立「檢查報告」資料庫...")
    # 若無法取得父頁面，使用原資料庫同層的 workspace
    if parent_page_id:
        parent = {"type": "page_id", "page_id": parent_page_id}
    else:
        parent = {"type": "workspace", "workspace": True}

    body = {
        "parent": parent,
        "icon":   {"type": "emoji", "emoji": "📋"},
        "title":  [{"type": "text", "text": {"content": "MEP 檢查報告"}}],
        "properties": {
            "報告名稱":   {"title": {}},
            "專案名稱":   {"rich_text": {}},
            "版次":       {"rich_text": {}},
            "核對日期":   {"date": {}},
            "送出者":     {"rich_text": {}},
            "完成率(%)":  {"number": {"format": "number"}},
            "符合項目":   {"number": {"format": "number"}},
            "問題項目":   {"number": {"format": "number"}},
            "不適用":     {"number": {"format": "number"}},
            "總項目數":   {"number": {"format": "number"}},
            "送出時間":   {"rich_text": {}},
        }
    }
    result = notion_req("POST", "/databases", body)
    if not result:
        print("❌ 建立報告資料庫失敗")
        sys.exit(1)
    db_id = result["id"]
    REPORT_DB_CACHE.write_text(db_id, encoding="utf-8")
    print(f"  ✅ 報告資料庫已建立（ID: {db_id[:8]}...）")
    return db_id

def get_or_create_report_db():
    # 先看快取
    if REPORT_DB_CACHE.exists():
        cached = REPORT_DB_CACHE.read_text(encoding="utf-8").strip()
        if cached:
            test = notion_req("GET", f"/databases/{cached}")
            if test and not test.get("archived"):
                return cached
            print("⚠️  快取的報告資料庫已不存在，重新建立...")

    # 決定父頁面
    if REPORT_PARENT_PAGE_ID.strip():
        # 使用手動指定的頁面
        pid = REPORT_PARENT_PAGE_ID.strip().replace("-","")
        # 格式化為標準 UUID
        pid = f"{pid[:8]}-{pid[8:12]}-{pid[12:16]}-{pid[16:20]}-{pid[20:]}"
        print(f"  使用手動指定頁面：{pid[:8]}...")
    else:
        pid = get_parent_page_id()
    return create_report_db(pid)

# ─── 狀態文字 ─────────────────────────────────────────────────────────────
STATUS_ICON = {"pass": "✅ 符合", "issue": "❌ 問題", "na": "—  不適用", "": "□  待核對"}
SEV_LABEL   = {"A": "🔴 A 必修正", "B": "🟡 B 建議確認", "C": "🟢 C 建議優化"}

# ─── 建立頁面內容（blocks）────────────────────────────────────────────────
def build_blocks(report):
    meta = report["meta"]
    blocks = []

    # ── 摘要標題區塊 ─────────────────────────────────────────────────────
    blocks.append({
        "object": "block", "type": "callout",
        "callout": {
            "icon": {"type": "emoji", "emoji": "📊"},
            "color": "blue_background",
            "rich_text": [{
                "type": "text",
                "text": {"content":
                    f"專案：{meta['proj']}  |  版次：{meta.get('rev','') or '—'}  |  日期：{meta.get('date','') or '—'}\n"
                    f"送出者：{meta['submitter']}  |  完成率：{meta['pct']}%  |  "
                    f"符合 {meta['pass']} 項 / 問題 {meta['issue']} 項 / 不適用 {meta['na']} 項 / 共 {meta['total']} 項"
                }
            }]
        }
    })

    # ── 各系統明細 ────────────────────────────────────────────────────────
    for sys in report["systems"]:
        # 系統標題
        blocks.append({
            "object": "block", "type": "heading_1",
            "heading_1": {"rich_text": [{"type": "text", "text": {"content": f"{sys['icon']} {sys['name']}"}}]}
        })

        for sub in sys["subs"]:
            # 子系統標題
            blocks.append({
                "object": "block", "type": "heading_2",
                "heading_2": {"rich_text": [{"type": "text", "text": {"content": f"{sub['icon']} {sub['name']}"}}]}
            })

            for item in sub["items"]:
                status = item.get("status", "")
                note   = item.get("note", "")
                sev    = item.get("sev", "")
                color  = "red_background" if status == "issue" else \
                         "green_background" if status == "pass" else \
                         "gray_background" if status == "na" else "default"

                # 項目 callout（含備註）
                content = f"{STATUS_ICON.get(status,'□')}  [{SEV_LABEL.get(sev,sev)}]  {item['text']}"
                if item.get("basis"):
                    content += f"\n📋 {item['basis']}"
                if note:
                    content += f"\n📝 備註：{note}"

                # Notion block content 限 2000 字
                if len(content) > 1990:
                    content = content[:1990] + "…"

                blocks.append({
                    "object": "block", "type": "callout",
                    "callout": {
                        "icon": {"type": "emoji", "emoji":
                            "✅" if status=="pass" else
                            "❌" if status=="issue" else
                            "➖" if status=="na" else "⬜"},
                        "color": color,
                        "rich_text": [{"type": "text", "text": {"content": content}}]
                    }
                })

        blocks.append({"object": "block", "type": "divider", "divider": {}})

    return blocks

# ─── 建立報告頁面 ──────────────────────────────────────────────────────────
def create_report_page(report_db_id, report):
    meta = report["meta"]
    # 分批傳送 blocks（Notion 每次最多 100 個）
    blocks = build_blocks(report)

    # 報告名稱
    proj = meta["proj"]
    rev  = meta.get("rev") or ""
    date = meta.get("date") or ""
    title_str = f"{proj}{' '+rev if rev else ''} {date}".strip()

    props = {
        "報告名稱": {"title": [{"text": {"content": title_str}}]},
        "專案名稱": {"rich_text": [{"text": {"content": proj}}]},
        "版次":     {"rich_text": [{"text": {"content": rev}}]},
        "送出者":   {"rich_text": [{"text": {"content": meta.get("submitter","")}}]},
        "完成率(%)":{"number": meta.get("pct", 0)},
        "符合項目": {"number": meta.get("pass", 0)},
        "問題項目": {"number": meta.get("issue", 0)},
        "不適用":   {"number": meta.get("na", 0)},
        "總項目數": {"number": meta.get("total", 0)},
        "送出時間": {"rich_text": [{"text": {"content": meta.get("submittedAt","")}}]},
    }
    if date:
        props["核對日期"] = {"date": {"start": date}}

    # 第一批 blocks（最多 100）
    first_batch = blocks[:100]
    body = {
        "parent":     {"database_id": report_db_id},
        "icon":       {"type": "emoji", "emoji": "📋"},
        "properties": props,
        "children":   first_batch,
    }
    result = notion_req("POST", "/pages", body)
    if not result:
        print("❌ 建立報告頁面失敗")
        return None
    page_id = result["id"]
    print(f"  ✅ 報告頁面已建立（{len(first_batch)} 個 block）")

    # 後續批次（若 blocks > 100）
    for i in range(100, len(blocks), 100):
        batch = blocks[i:i+100]
        r = notion_req("PATCH", f"/blocks/{page_id}/children", {"children": batch})
        if r:
            print(f"  ✅ 新增 block {i+1}~{i+len(batch)}")
        else:
            print(f"  ⚠️  block {i+1}~{i+len(batch)} 新增失敗")

    return page_id

# ─── 主程式 ───────────────────────────────────────────────────────────────
def main():
    # 找 JSON 檔
    if len(sys.argv) >= 2:
        json_path = Path(sys.argv[1])
    else:
        files = sorted(SCRIPT_DIR.glob("report_*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not files:
            print("❌ 找不到 report_*.json，請先在網頁按「送出報告」下載 JSON")
            input("按 Enter 關閉...")
            sys.exit(1)
        json_path = files[0]
        print(f"📄 使用最新報告：{json_path.name}")

    if not json_path.exists():
        print(f"❌ 檔案不存在：{json_path}")
        input("按 Enter 關閉...")
        sys.exit(1)

    report = json.loads(json_path.read_text(encoding="utf-8"))
    meta   = report["meta"]

    print(f"\n{'='*55}")
    print(f"  MEP 檢查報告 → Notion")
    print(f"{'='*55}")
    print(f"  專案：{meta['proj']}  版次：{meta.get('rev') or '—'}")
    print(f"  日期：{meta.get('date') or '—'}  送出者：{meta.get('submitter','')}")
    print(f"  完成率 {meta['pct']}%  |  符合 {meta['pass']} / 問題 {meta['issue']} / 不適用 {meta['na']}")
    print(f"{'='*55}\n")

    print("🔍 取得 / 建立報告資料庫...")
    report_db_id = get_or_create_report_db()

    print("📝 寫入報告明細...")
    page_id = create_report_page(report_db_id, report)

    if page_id:
        print(f"\n🎉 完成！報告已新增至 Notion 報告資料庫")
    else:
        print(f"\n❌ 報告寫入失敗")

    input("\n按 Enter 關閉...")

if __name__ == "__main__":
    main()
