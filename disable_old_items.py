#!/usr/bin/env python3
"""
disable_old_items.py
====================
將 Notion 資料庫中舊版扁平項目的「啟用」欄位設為 false。
舊項目：e01-e08, w01-w08, d01-d07, f01-f08, h01-h08（共 39 筆）
"""

import io, json, sys, urllib.request, urllib.error
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOKEN  = "ntn_Y36273413268N3qINTubBtDxXTJUiBSr3w36Il3SNaK29v"
DB_ID  = "bc49a5edcbef4dd1b0ce16a3b52d8b6c"
VER    = "2022-06-28"

OLD_IDS = (
    [f"e{i:02d}" for i in range(1, 9)] +   # e01~e08
    [f"w{i:02d}" for i in range(1, 9)] +   # w01~w08
    [f"d{i:02d}" for i in range(1, 8)] +   # d01~d07
    [f"f{i:02d}" for i in range(1, 9)] +   # f01~f08
    [f"h{i:02d}" for i in range(1, 9)]     # h01~h08
)

def notion_request(method, path, body=None):
    url = f"https://api.notion.com/v1{path}"
    headers = {
        "Authorization":  f"Bearer {TOKEN}",
        "Notion-Version": VER,
        "Content-Type":   "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req  = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
        return None

def query_all_pages():
    """撈出資料庫所有頁面（分頁）。"""
    pages, cursor = [], None
    while True:
        body = {"page_size": 100, "sorts": [{"property": "排序", "direction": "ascending"}]}
        if cursor:
            body["start_cursor"] = cursor
        data = notion_request("POST", f"/databases/{DB_ID}/query", body)
        if not data:
            break
        pages.extend(data.get("results", []))
        if data.get("has_more"):
            cursor = data.get("next_cursor")
        else:
            break
    return pages

def get_title(page):
    props = page.get("properties", {})
    titles = props.get("項目ID", {}).get("title", [])
    return titles[0]["plain_text"] if titles else ""

def disable_page(page_id):
    body = {"properties": {"啟用": {"checkbox": False}}}
    return notion_request("PATCH", f"/pages/{page_id}", body)

# ─── 主程式 ─────────────────────────────────────────────────────────────────
print("🔍 查詢 Notion 資料庫中...")
all_pages = query_all_pages()
print(f"   共找到 {len(all_pages)} 筆頁面\n")

old_set = set(OLD_IDS)
targets = [(p["id"], get_title(p)) for p in all_pages if get_title(p) in old_set]

print(f"📋 找到 {len(targets)} 筆舊項目需要停用：")
for pid, tid in targets:
    print(f"   - {tid}")

print(f"\n🔒 開始停用...")
ok = 0
for pid, tid in targets:
    result = disable_page(pid)
    if result:
        ok += 1
        print(f"   ✅ {tid} 已停用")
    else:
        print(f"   ❌ {tid} 失敗")

print(f"\n{'='*40}")
print(f"完成: {ok}/{len(targets)} 筆停用成功")
if ok == len(targets):
    print("🎉 全部完成！現在可以執行 sync_and_push.bat")
else:
    missing = set(OLD_IDS) - {tid for _, tid in targets}
    if missing:
        print(f"⚠️  以下項目在 Notion 中找不到：{sorted(missing)}")
