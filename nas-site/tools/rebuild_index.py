#!/usr/bin/env python3
"""重建 data/index.js（網頁上的「重新掃描並重建索引」做的是同一件事）。

用法：在圖片庫資料夾執行
    python tools/rebuild_index.py
或指定資料夾：
    python tools/rebuild_index.py "\\\\NAS\\share\\蜘蛛文獻圖片庫"
"""
import json
import sys
import time
from pathlib import Path

TYPES = ["figure", "reference", "species", "structure"]


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    if not (root / "data" / "library.json").exists():
        sys.exit(f"{root} 不是蜘蛛文獻圖片庫資料夾（找不到 data/library.json）")
    records, bad = [], []
    for kind in TYPES:
        for path in sorted((root / "data" / "records" / kind).glob("*.json")):
            try:
                rec = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                bad.append(f"{path}: {e}")
                continue
            rec.update(type=kind, id=path.stem, _mtime=int(path.stat().st_mtime * 1000))
            records.append(rec)
    index = {"generated": int(time.time() * 1000), "records": records}
    out = root / "data" / "index.js"
    out.write_text("window.SPIDER_INDEX = " + json.dumps(index, ensure_ascii=False) + ";\n", encoding="utf-8")
    counts = {k: sum(r["type"] == k for r in records) for k in TYPES}
    print(f"已寫入 {out}：圖片 {counts['figure']}、文獻 {counts['reference']}、"
          f"物種資料 {counts['species']}、構造類別 {counts['structure']}")
    for b in bad:
        print("無法讀取：", b)


if __name__ == "__main__":
    main()
