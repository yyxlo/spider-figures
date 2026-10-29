# 蜘蛛文獻圖片資料庫

把蜘蛛物種在文獻中的圖（觸肢、外生殖器、外觀等）整理成資料庫。查詢科、屬、種名就能直接看到所有文獻圖，鑑定時可以並排比對，不用每次重新翻紙本或打開 PDF。

設計給自己或小團隊在**實驗室內網**使用，所有頁面與圖片都需要登入才能看到。

## 兩種版本

| 版本 | 適合 | 說明 |
|---|---|---|
| **NAS 資料夾版**（`nas-site/`） | 內網電腦之間無法連線網站，但都能開 NAS 共用資料夾 | 不需要伺服器。整個圖片庫是一個資料夾，雙擊 `index.html` 用 Edge / Chrome 開啟。說明見 [`nas-site/README.md`](nas-site/README.md) |
| **伺服器版**（本頁以下內容） | 有一台電腦或主機能讓其他人連線 | Django + PostgreSQL，用 Docker 執行，有登入功能 |

伺服器版的資料可以用 `export_static` 指令匯出成 NAS 資料夾版，步驟見 `nas-site/README.md` 的「從 Docker 版搬移資料」。

## 功能

- **搜尋**：輸入科、屬、種學名或中文名，打字時會出現建議清單。可以用縮寫屬名（`A. ventri`）。使用 PostgreSQL 時，拼錯字也找得到相近的名稱。
- **屬頁**：該屬所有種的圖排成一列一列，可用「構造」「性別」篩選，例如只看全屬的雄觸肢。勾選幾個種就能並排比較。
- **物種頁**：圖片依構造分區，每張標示出處（作者 年份: 頁碼, 圖號）。點圖片放大，可用滾輪縮放、拖曳移動。
- **同物異名**：文獻用舊名或舊組合時，圖片掛在文獻上的名稱，並連到現行有效名。查有效名時，舊名下的圖會一起顯示。
- **並排比較**：選好幾個物種與構造，圖片並排顯示，每張圖可以各自縮放。
- **上傳**：一次拖放多張圖，套用同一個物種與文獻，下一步再逐張補圖號、構造、性別、視角。上傳時會自動產生縮圖。
- **文獻管理**：每篇文獻有自己的頁面，可複製引用格式、匯出 BibTeX、連到 DOI。
- **後台**（`/admin/`）：管理名錄、文獻、構造類別與使用者帳號。

## 在實驗室電腦上安裝

### 1. 需要的軟體

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)（Windows / macOS），或 Linux 上的 Docker Engine 加 Docker Compose 外掛
- Git（用來從 GitHub 下載程式碼）

### 2. 下載程式碼並設定

```bash
git clone <你的 GitHub repository 網址> spider-figures
cd spider-figures
cp .env.example .env        # Windows PowerShell：copy .env.example .env
```

用文字編輯器打開 `.env`，至少要修改：

- `DJANGO_SECRET_KEY`：一串隨機長字串。可以用 `python3 -c "import secrets; print(secrets.token_urlsafe(50))"` 產生
- `POSTGRES_PASSWORD`：資料庫密碼，自己訂一個

這兩個值裡**不要有 `$` 符號**。Docker Compose 會把 `$xxx` 當成變數，出現 `The "xxx" variable is not set` 警告，實際的值也會被改掉。一定要用 `$` 的話，請把整個值用單引號包起來，例如 `POSTGRES_PASSWORD='pa$$word'`。

### 3. 啟動

先打開 Docker Desktop，等狀態顯示 Engine running。沒有開的話會出現 `failed to connect to the docker API at npipe:////./pipe/docker_engine` 錯誤。

```bash
docker compose up -d --build
```

第一次啟動要下載映像檔並建置，需要幾分鐘。之後只要 `docker compose up -d` 即可。

### 4. 建立管理者帳號

```bash
docker compose exec web python manage.py createsuperuser
```

接著用瀏覽器打開 `http://localhost:8000` 登入。

### 5. 讓內網其他電腦連線

1. 查這台電腦的內網 IP（Windows：`ipconfig`；macOS / Linux：`ip addr` 或系統設定），例如 `192.168.1.50`
2. 其他電腦用瀏覽器開 `http://192.168.1.50:8000`
3. 如果登入時出現 CSRF 錯誤，在 `.env` 設定 `DJANGO_CSRF_TRUSTED_ORIGINS=http://192.168.1.50:8000`，再執行 `docker compose up -d`
4. 作業系統防火牆可能需要允許 8000 埠的連入

其他成員的帳號由管理者在後台「使用者」新增。一般成員不需要勾選「工作人員狀態」；勾選後才能進入後台。

如果第一次啟動時密碼設錯（例如被 `$` 改掉），改好 `.env` 後要清掉資料庫重建：`docker compose down -v` 再 `docker compose up -d --build`。**`-v` 會刪除資料庫**，只在還沒有資料時使用。

### 停止、更新

```bash
docker compose down            # 停止（資料會保留）
git pull && docker compose up -d --build   # 更新程式碼後重新建置
```

## 匯入 World Spider Catalog 名錄

> **請先確認授權。** 我在撰寫這個程式時無法連上 WSC 網站，所以**沒有確認**目前的下載方式、匯出檔的欄位格式與使用條款。印象中 WSC 的資料下載需要註冊帳號並同意其使用條款，但請以 https://wsc.nmbe.ch 上的說明為準。

匯入指令會依欄位名稱自動對應，支援的欄位名稱（不分大小寫）如下：

| 資料 | 可辨識的欄位名稱 |
|---|---|
| 科（必要） | `family` |
| 屬（必要） | `genus` |
| 種小名（必要） | `species`、`epithet`、`specificEpithet` |
| 亞種名 | `subspecies`、`infraspecificEpithet` |
| 命名者 | `author`、`authorship`、`scientificNameAuthorship` |
| 年份 | `year` |
| 是否加括號 | `parens`、`parentheses`（1/true 代表加括號） |
| LSID | `species_lsid`、`lsid`、`taxonID` |
| 中文名 | `common_name`、`chinese_name`、`中文名` |
| 分類階層 / 狀態 | `taxonRank`、`taxonomicStatus`（若有，只匯入 accepted 的種與亞種） |

步驟：

```bash
# 1. 把下載的檔案放進 imports/ 資料夾
# 2. 先試跑，檢查欄位對應是否正確（不會寫入資料庫）
docker compose exec web python manage.py import_wsc /app/imports/檔名.csv --dry-run
# 3. 確認無誤後正式匯入
docker compose exec web python manage.py import_wsc /app/imports/檔名.csv
```

其他選項：

- 欄位名稱對不上時手動指定：`--column species=epithet --column author=species_author`
- 只匯入某些科：`--family Araneidae --family Theridiidae`
- 重複匯入同一個檔案是安全的，已存在的種會更新命名者等資料，不會重複建立

如果不想匯入整份名錄，也可以只用網站上的「新增物種名」逐筆建立，或用相同格式自己整理 CSV 匯入。

同物異名目前需要手動建立：在「新增物種名」或後台新增該名稱，並在「有效名」欄位指向現行有效名。

## 備份與還原

資料包含兩部分：PostgreSQL 資料庫（放在 Docker volume `pgdata`）和圖片檔（`data/media/`）。

```bash
./scripts/backup.sh                              # 備份到 backups/<日期時間>/
./scripts/restore.sh backups/20260101-120000     # 還原（會覆蓋現有資料）
```

建議定期把 `backups/` 複製到外接硬碟或 NAS。Windows 上請在 Git Bash 或 WSL 執行這兩個腳本。

## 開發模式（不用 Docker）

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python manage.py migrate
.venv/bin/python manage.py createsuperuser
.venv/bin/python manage.py runserver
```

沒有設定 `POSTGRES_DB` 環境變數時會使用 SQLite（`data/db.sqlite3`），此時沒有拼錯字的模糊搜尋。

執行測試：`.venv/bin/python manage.py test catalog`

## 專案結構

```
config/            Django 設定與網址
catalog/
  models.py        科、屬、種、文獻、構造類別、圖片
  views.py         各頁面
  search.py        名稱搜尋（含 PostgreSQL 模糊搜尋）
  forms.py         上傳與編輯表單
  management/commands/import_wsc.py   名錄匯入指令
  templates/       頁面模板
  tests.py         自動測試
static/            CSS 與 JavaScript（不依賴外部套件，離線可用）
scripts/           備份與還原腳本
```

## 注意事項

- **著作權**：文獻圖片有著作權。這個系統設計成只在內網、登入後才能看到圖片，並在每張圖標示出處。建議不要對外公開。這不是法律意見。
- **HTTPS**：系統預設以 HTTP 在內網運作。若要讓外部網路連入，應另外架設 HTTPS 反向代理，並重新評估上面的著作權問題。
- **構造類別**可以在後台「構造類別」新增、改名或調整順序。
