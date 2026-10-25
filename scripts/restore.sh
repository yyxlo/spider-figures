#!/usr/bin/env bash
# 從 backups/<日期時間>/ 還原資料庫與圖片檔（會覆蓋現有資料）
# 用法：./scripts/restore.sh backups/20260101-120000
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:?請指定備份資料夾，例如 backups/20260101-120000}"
read -r -p "這會覆蓋目前的資料庫與圖片，確定要還原 $src 嗎？(yes/no) " ans
[ "$ans" = "yes" ] || { echo "已取消"; exit 1; }
docker compose exec -T db pg_restore -U spider -d spider --clean --if-exists < "$src/database.dump"
rm -rf data/media
tar -xzf "$src/media.tar.gz" -C data
echo "還原完成"
