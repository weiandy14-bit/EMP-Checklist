#!/usr/bin/env python3
"""
sync_notion.py
==============
從 Notion 資料庫讀取自主檢查項目，重建 index.html 的 DATA 陣列。

使用方式:
    set NOTION_TOKEN=secret_xxxx
    python sync_notion.py

可選參數:
    --dry-run   只輸出產生的 JS，不寫入 index.html
    --db-id     指定 Notion 資料庫 ID（預設已內建）
"""

import io
import os
import re
import sys
import json
import argparse
import urllib.request
import urllib.error
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ─── 設定 ──────────────────────────────────────────────────────────────────
DB_ID       = "bc49a5edcbef4dd1b0ce16a3b52d8b6c"
INDEX_HTML  = Path(__file__).parent / "index.html"
NOTION_VER  = "2022-06-28"

# 系統 metadata（與 index.html 同步）
SYS_META = {
    "電力系統":     dict(id="power", num=1, icon="⚡",  color="#3b82f6", bg="#eff6ff", expandable=True),
    "弱電系統":     dict(id="elv",   num=2, icon="📡",  color="#8b5cf6", bg="#f5f3ff", expandable=True),
    "給水系統":     dict(id="water", num=3, icon="💧",  color="#06b6d4", bg="#ecfeff", expandable=True),
    "排水系統":     dict(id="drain", num=4, icon="🔄",  color="#64748b", bg="#f8fafc", expandable=True),
    "消防系統":     dict(id="fire",  num=5, icon="🔥",  color="#ef4444", bg="#fef2f2", expandable=True),
    "空調系統":     dict(id="hvac",  num=6, icon="❄️",  color="#0ea5e9", bg="#f0f9ff", expandable=True),
}

# 子系統 metadata（依系統分組，expandable=True 的系統才需要）
SYS_SUB_META: dict[str, dict] = {
    "電力系統": {
        "動力系統":        dict(id="pw-motor",  icon="⚙️",  name="① 動力系統"),
        "照明系統":        dict(id="pw-light",  icon="💡",  name="② 照明系統"),
        "系統單線・升位圖": dict(id="pw-sld",   icon="📊",  name="③ 系統單線・升位圖"),
        "太陽能系統":      dict(id="pw-solar",  icon="☀️",  name="④ 太陽能系統"),
        "大樣圖詳細圖":    dict(id="pw-detail", icon="🔍",  name="⑤ 大樣圖詳細圖"),
        "外牆燈系統":      dict(id="pw-facade", icon="🏙️", name="⑥ 外牆燈系統"),
        "緊急發電機系統":  dict(id="pw-genset", icon="🔋",  name="⑦ 緊急發電機系統"),
        "避雷接地系統":    dict(id="pw-grnd",   icon="🌍",  name="⑧ 避雷接地系統"),
    },
    "弱電系統": {
        "電信設備工程":         dict(id="elv-tel",    icon="📞",  name="① 電信設備工程"),
        "光纖設備工程":         dict(id="elv-fib",    icon="🔆",  name="② 光纖設備工程"),
        "電視共同天線設備工程": dict(id="elv-tv",     icon="📺",  name="③ 電視共同天線設備工程"),
        "鋁製電纜線架工程":     dict(id="elv-tray",   icon="🔩",  name="④ 鋁製電纜線架工程"),
        "監視系統設備工程":     dict(id="elv-cctv",   icon="📷",  name="⑤ 監視系統設備工程"),
        "停管設備工程":         dict(id="elv-park",   icon="🅿️", name="⑥ 停管設備工程"),
        "門禁管制系統工程":     dict(id="elv-access", icon="🔐",  name="⑦ 門禁管制系統工程"),
        "中央監控系統設備工程": dict(id="elv-bms",    icon="🖥️", name="⑧ 中央監控系統設備工程"),
    },
    "給水系統": {
        "衛生器具":         dict(id="wt-fixture", icon="🚿",  name="① 衛生器具"),
        "給水設備工程":     dict(id="wt-supply",  icon="🔧",  name="② 給水設備工程"),
        "組合式水箱系統":   dict(id="wt-tank",    icon="🗄️", name="③ 組合式水箱系統"),
        "雨水回收設備工程": dict(id="wt-rain",    icon="🌧️", name="④ 雨水回收設備工程"),
        "油脂截留設備工程": dict(id="wt-grease",  icon="🍳",  name="⑤ 油脂截留設備工程"),
        "垃圾冷藏設備工程": dict(id="wt-gcold",   icon="🧊",  name="⑥ 垃圾冷藏設備工程"),
    },
    "排水系統": {
        "排水設備工程":     dict(id="dr-drain", icon="🪣",  name="① 排水設備工程"),
        "空調冷凝排水系統": dict(id="dr-cond",  icon="💦",  name="② 空調冷凝排水系統"),
    },
    "空調系統": {
        "空調水系統":         dict(id="hv-water", icon="🌊",  name="① 空調水系統"),
        "空調風系統":         dict(id="hv-air",   icon="💨",  name="② 空調風系統"),
        "圖說設備規格表":     dict(id="hv-spec",  icon="📋",  name="③ 圖說設備規格表"),
        "系統、升位、施工大樣圖": dict(id="hv-dwg", icon="📐", name="④ 系統、升位、施工大樣圖"),
        "控制圖、IO點位表":   dict(id="hv-ctrl",  icon="🗂️", name="⑤ 控制圖、IO點位表"),
        "空調自動控制(監控)": dict(id="hv-auto",  icon="🖥️", name="⑥ 空調自動控制（監控）"),
        "噪音防制":           dict(id="hv-noise", icon="🔇",  name="⑦ 噪音防制"),
        "變頻多聯空調設備":   dict(id="hv-vrf",   icon="🔄",  name="⑧ 變頻多聯空調設備"),
        "可變風量控制系統":   dict(id="hv-vav",   icon="🌬️", name="⑨ 可變風量控制系統"),
    },
    "消防系統": {
        "消防栓及連結送水設備": dict(id="ff-hydrant", icon="🚒",  name="① 消防栓及連結送水設備"),
        "採水系統設備":         dict(id="ff-intake",  icon="💧",  name="② 採水系統設備"),
        "火警設備":             dict(id="ff-alarm",   icon="🔔",  name="③ 火警設備"),
        "緊急廣播設備":         dict(id="ff-pa",      icon="📢",  name="④ 緊急廣播設備"),
        "標示設備及避難器具設備": dict(id="ff-sign",  icon="🚪",  name="⑤ 標示設備及避難器具設備"),
        "自動灑水設備":         dict(id="ff-sprink",  icon="💦",  name="⑥ 自動灑水設備"),
        "泡沫滅火設備":         dict(id="ff-foam",    icon="🧯",  name="⑦ 泡沫滅火設備"),
        "排煙設備":             dict(id="ff-smoke",   icon="💨",  name="⑧ 排煙設備"),
        "消防無線電通訊設備":   dict(id="ff-radio",   icon="📡",  name="⑨ 消防無線電通訊設備"),
        "固定式放水型設備":     dict(id="ff-fixed",   icon="🔫",  name="⑩ 固定式放水型設備"),
        "移動式放水型設備":     dict(id="ff-mobile",  icon="🚿",  name="⑪ 移動式放水型設備"),
        "防火填塞":             dict(id="ff-seal",    icon="🧱",  name="⑬ 防火填塞"),
    },
}

# 嚴重性 SELECT 值對應
SEV_MAP = {
    "A 必修正":  "A",
    "B 建議確認": "B",
    "C 建議優化": "C",
}


# ─── Notion API ────────────────────────────────────────────────────────────
def notion_query(token: str, db_id: str) -> list[dict]:
    """分頁查詢 Notion 資料庫，返回所有 page 物件。"""
    url     = f"https://api.notion.com/v1/databases/{db_id}/query"
    headers = {
        "Authorization":  f"Bearer {token}",
        "Notion-Version": NOTION_VER,
        "Content-Type":   "application/json",
    }
    pages   = []
    cursor  = None

    while True:
        body = {"page_size": 100, "sorts": [{"property": "排序", "direction": "ascending"}]}
        if cursor:
            body["start_cursor"] = cursor

        req  = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            print(f"❌ Notion API 錯誤 {e.code}: {err}", file=sys.stderr)
            sys.exit(1)

        pages.extend(data.get("results", []))
        if data.get("has_more"):
            cursor = data.get("next_cursor")
        else:
            break

    return pages


def get_prop(page: dict, name: str):
    """安全取得 Notion property 值。"""
    props = page.get("properties", {})
    prop  = props.get(name, {})
    ptype = prop.get("type", "")

    if ptype == "title":
        rich = prop.get("title", [])
        return "".join(r.get("plain_text", "") for r in rich).strip()

    if ptype == "rich_text":
        rich = prop.get("rich_text", [])
        return "".join(r.get("plain_text", "") for r in rich).strip()

    if ptype == "select":
        sel = prop.get("select")
        return sel["name"] if sel else ""

    if ptype == "checkbox":
        return prop.get("checkbox", False)

    if ptype == "number":
        return prop.get("number")

    return ""


# ─── 資料解析 ─────────────────────────────────────────────────────────────
def parse_pages(pages: list[dict]) -> dict:
    """
    將 Notion pages 轉成巢狀結構：
        {
          "電力系統": {
            "動力系統": [ {id, sev, text, basis}, ... ],
            ...
          },
          "弱電系統": [ {id, sev, text, basis}, ... ],
          ...
        }
    """
    result = {}

    for page in pages:
        # 啟用 checkbox
        enabled = get_prop(page, "啟用")
        if isinstance(enabled, bool) and not enabled:
            continue  # 停用項目跳過

        system  = get_prop(page, "系統")
        sub     = get_prop(page, "子系統")
        item_id = get_prop(page, "項目ID")
        sev_raw = get_prop(page, "嚴重性")
        text    = get_prop(page, "核對項目")
        basis   = get_prop(page, "法規依據")

        if not system or not item_id or not text:
            continue  # 必填欄位缺失，跳過

        sev = SEV_MAP.get(sev_raw, "B")  # 預設 B

        item = dict(id=item_id, sev=sev, text=text, basis=basis or "")

        if system not in result:
            result[system] = {}

        if sub:
            # expandable 系統（有子系統）
            if sub not in result[system]:
                result[system][sub] = []
            result[system][sub].append(item)
        else:
            # flat 系統（無子系統）
            if "__items__" not in result[system]:
                result[system]["__items__"] = []
            result[system]["__items__"].append(item)

    return result


# ─── JS 序列化 ────────────────────────────────────────────────────────────
def js_str(s: str) -> str:
    """將 Python 字串轉成 JS 單引號字串（自動跳脫）。"""
    # 跳脫反斜線、單引號
    s = s.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{s}'"


def indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return "\n".join(pad + line if line.strip() else line for line in text.splitlines())


def build_item_js(item: dict, ind: int) -> str:
    pad = " " * ind
    return (
        f"{pad}{{id:{js_str(item['id'])},"
        f"sev:{js_str(item['sev'])},"
        f"text:{js_str(item['text'])},"
        f"basis:{js_str(item['basis'])}}}"
    )


def build_data_js(notion_data: dict) -> str:
    """依照 SYS_META 順序建構 JS DATA 字串。"""
    sys_order = list(SYS_META.keys())
    lines = ["const DATA = ["]

    for sys_name in sys_order:
        meta = SYS_META[sys_name]
        sys_dict = notion_data.get(sys_name, {})

        # 系統開頭
        icon_js  = js_str(meta["icon"])
        name_js  = js_str(sys_name)
        color_js = js_str(meta["color"])
        bg_js    = js_str(meta["bg"])
        exp_str  = "true" if meta["expandable"] else "false"

        lines.append(f"  {{")
        lines.append(f"    id:{js_str(meta['id'])}, num:{meta['num']}, icon:{icon_js}, name:{name_js}, color:{color_js}, bg:{bg_js},")
        lines.append(f"    expandable: {exp_str},")

        if meta["expandable"]:
            # 有子系統 → subs 陣列（依 SYS_SUB_META 中該系統的順序）
            sub_meta_map = SYS_SUB_META.get(sys_name, {})
            sub_order    = list(sub_meta_map.keys())
            lines.append(f"    subs:[")
            for sub_name in sub_order:
                sub_meta = sub_meta_map[sub_name]
                items    = sys_dict.get(sub_name, [])
                if not items:
                    continue
                lines.append(f"      {{")
                lines.append(f"        id:{js_str(sub_meta['id'])}, name:{js_str(sub_meta['name'])}, icon:{js_str(sub_meta['icon'])},")
                lines.append(f"        items:[")
                for item in items:
                    lines.append(build_item_js(item, 10) + ",")
                lines.append(f"        ]")
                lines.append(f"      }},")
            lines.append(f"    ]")
        else:
            # flat 系統 → items 陣列
            items = sys_dict.get("__items__", [])
            lines.append(f"    items:[")
            for item in items:
                lines.append(build_item_js(item, 6) + ",")
            lines.append(f"    ]")

        lines.append(f"  }},")

    lines.append("];")
    return "\n".join(lines)


# ─── 寫入 index.html ──────────────────────────────────────────────────────
def update_index_html(new_js: str, html_path: Path):
    content = html_path.read_text(encoding="utf-8")

    # 找到 const DATA = [ ... ]; 區塊（跨行，含結尾 ;）
    pattern = r"const DATA = \[[\s\S]*?\];"
    match   = re.search(pattern, content)
    if not match:
        print("❌ 在 index.html 中找不到 const DATA = [...]; 區塊", file=sys.stderr)
        sys.exit(1)

    new_content = content[:match.start()] + new_js + content[match.end():]
    html_path.write_text(new_content, encoding="utf-8")
    print(f"✅ 已更新 {html_path}")


# ─── 主程式 ───────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="從 Notion 同步自主檢查項目到 index.html")
    parser.add_argument("--dry-run", action="store_true", help="只印出 JS，不寫入檔案")
    parser.add_argument("--db-id",   default=DB_ID,        help="Notion 資料庫 ID")
    args = parser.parse_args()

    token = os.environ.get("NOTION_TOKEN", "").strip()
    if not token:
        print("❌ 請先設定環境變數 NOTION_TOKEN", file=sys.stderr)
        print("   Windows: set NOTION_TOKEN=secret_xxxx", file=sys.stderr)
        print("   macOS/Linux: export NOTION_TOKEN=secret_xxxx", file=sys.stderr)
        sys.exit(1)

    print(f"🔍 查詢 Notion 資料庫 {args.db_id} ...")
    pages = notion_query(token, args.db_id)
    print(f"   取得 {len(pages)} 筆記錄")

    notion_data = parse_pages(pages)

    # 統計
    for sys_name, sys_dict in notion_data.items():
        if "__items__" in sys_dict:
            cnt = len(sys_dict["__items__"])
            print(f"   {sys_name}: {cnt} 項")
        else:
            for sub, items in sys_dict.items():
                print(f"   {sys_name} / {sub}: {len(items)} 項")

    new_js = build_data_js(notion_data)

    if args.dry_run:
        print("\n─── 產生的 JS ───────────────────────────────────────────────")
        print(new_js)
        print("─────────────────────────────────────────────────────────────")
        return

    update_index_html(new_js, INDEX_HTML)
    print("🎉 同步完成！可執行 git diff index.html 確認變更。")


if __name__ == "__main__":
    main()
