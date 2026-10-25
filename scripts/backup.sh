#!/usr/bin/env bash
# 備份資料庫與圖片檔到 backups/<日期時間>/
# 用法：在專案資料夾執行 ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
stamp=$(date +%Y%m%d-%H%M%S)
dest="backups/$stamp"
mkdir -p "$dest"
docker compose exec -T db pg_dump -U spider -d spider --format=custom > "$dest/database.dump"
tar -czf "$dest/media.tar.gz" -C data media
echo "備份完成：$dest"
ls -lh "$dest"
