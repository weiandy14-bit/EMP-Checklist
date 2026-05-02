#!/usr/bin/env python3
"""
update_vent_grnd.py
===================
1. 停用通風系統 v01~v07（啟用 = false）
2. 將避雷接地系統 g01~g10 移至 電力系統 / 避雷接地系統
   並重新設定排序（電力系統 sort: 50~59，放在緊急發電機系統後面）
"""

import io, json, sys, urllib.request, urllib.error
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOKEN = "ntn_Y36273413268N3qINTubBtDxXTJUiBSr3w36Il3SNaK29v"
DB_ID = "bc49a5edcbef4dd1b0ce16a3b52d8b6c"
VER   = "2022-06-28"

VENT_IDS  = {f"v{i:02d}" for i in range(1, 8)}   # v01~v07
GRND_IDS  = {f"g{i:02d}" for i in range(1, 11)}  # g01~g10


def notion_request(method, path, body=None):
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
        print(f"  HTTP {e.code}: {e.read().decode()[:300]}")
        return None


def query_all():
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
    props  = page.get("properties", {})
    titles = props.get("項目ID", {}).get("title", [])
    return titles[0]["plain_text"] if titles else ""


# ─── 查詢所有頁面 ─────────────────────────────────────────────────────────────
print("🔍 查詢 Notion 資料庫...")
all_pages = query_all()
print(f"   共 {len(all_pages)} 筆\n")

vent_targets = []
grnd_targets = []

for p in all_pages:
    tid = get_title(p)
    if tid in VENT_IDS:
        vent_targets.append((p["id"], tid))
    elif tid in GRND_IDS:
        grnd_targets.append((p["id"], tid))

print(f"📋 通風系統 (v01~v07) 找到 {len(vent_targets)} 筆：{[t for _,t in vent_targets]}")
print(f"📋 避雷接地系統 (g01~g10) 找到 {len(grnd_targets)} 筆：{[t for _,t in grnd_targets]}\n")

# ─── 1. 停用通風系統 ──────────────────────────────────────────────────────────
print("🔒 停用通風系統項目...")
ok_vent = 0
for pid, tid in sorted(vent_targets, key=lambda x: x[1]):
    result = notion_request("PATCH", f"/pages/{pid}", {
        "properties": {"啟用": {"checkbox": False}}
    })
    if result:
        ok_vent += 1
        print(f"   ✅ {tid} 已停用")
    else:
        print(f"   ❌ {tid} 失敗")

# ─── 2. 移動避雷接地系統到電力系統 ───────────────────────────────────────────
print(f"\n🔀 移動避雷接地系統到 電力系統 / 避雷接地系統...")
ok_grnd = 0
# 排序從 50 開始（電力系統原有項目排序 1~49，50起給避雷接地）
sort_num_map = {
    "g01":50,"g02":51,"g03":52,"g04":53,"g05":54,
    "g06":55,"g07":56,"g08":57,"g09":58,"g10":59,
}
for pid, tid in sorted(grnd_targets, key=lambda x: x[1]):
    sort_val = sort_num_map.get(tid, 59)
    result = notion_request("PATCH", f"/pages/{pid}", {
        "properties": {
            "系統":   {"select": {"name": "電力系統"}},
            "子系統": {"select": {"name": "避雷接地系統"}},
            "排序":   {"number": sort_val},
        }
    })
    if result:
        ok_grnd += 1
        print(f"   ✅ {tid} → 電力系統/避雷接地系統 (排序 {sort_val})")
    else:
        print(f"   ❌ {tid} 失敗")

# ─── 結果 ────────────────────────────────────────────────────────────────────
print(f"\n{'='*50}")
print(f"通風系統停用: {ok_vent}/{len(vent_targets)}")
print(f"避雷接地移動: {ok_grnd}/{len(grnd_targets)}")
if ok_vent == len(vent_targets) and ok_grnd == len(grnd_targets):
    print("🎉 全部完成！")
else:
    print("⚠️  有項目失敗，請檢查上方錯誤訊息")
