# application115 importer（P2）

範圍：115 學年度 × 大學申請入學，官方資料 only。

## 為什麼只能人工下載

`https://www.cac.edu.tw/robots.txt` 為 `Disallow: /`（全站禁自動抓取）。
因此本 importer **不提供 `--url` 自動下載**，只接受 `--input <local-file>`。
詳見 `docs/data-sources/official-115-application.md`。

## 用法

```bash
# dry-run（不碰 DB，只產生預覽＋報告）
npm run data:import -- --source application115 --year 115 --input data/raw/official/115/application/dept.csv --dry-run

# 正式匯入（需 .env.local 有 DATABASE_URL）
npm run data:import -- --source application115 --year 115 --input data/raw/official/115/application/dept.csv
```

## 支援格式

- `*.htm / *.html`：甄選會行動版校系分則明細頁（key-value 表格泛用抽取；已確認標籤才映射，其餘進 warning）。
- `*.csv`：正規欄位（見 parser.ts `CSV_COLUMNS`），人工整理官方資料用。
- `*.json`：`{ "records": [...] }`，欄位同 CSV。

## 流程保證

parser 不寫 DB；dry-run 連 DB client 都不建立；正式匯入單一 transaction＋upsert＋`data_import_runs`；
解析失敗的 row 必進 `import-report.json` 的 `error_details`。
