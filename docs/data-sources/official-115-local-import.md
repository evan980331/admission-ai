# Official 115 Local Import（P3.11，全離線）

## 1. CAC robots 限制

cac.edu.tw 全站 `Disallow: /`，P2.5 crawler 維持拒絕批量。本管線**零網路**，
只能處理人工已下載的本機 HTML。

## 2. 為何採人工下載

在 robots 允許自動抓取之前，唯一合規的取得方式是瀏覽器人工另存。
管線設計成「檔案放進來即自動處理」，下載與處理完全解耦。

## 3. 官方 HTML 如何放置

放到 `data/raw/official/115/application/`（遞迴掃描，只收 `.htm/.html`；
`.pdf/.json/.meta.json` 一律略過）。P3.9 產生的 `.meta.json` 若在旁邊，
會被拿來做 source 驗證（不會被當成輸入）。

## 4. CLI 使用方式

```bash
npm run data:import-official-local -- --dry-run
npm run data:import-official-local -- --input ./downloads --output ./out115
```

`--input` 預設 raw 目錄、`--output` 預設
`data/processed/official/115/local-import`（gitignored）、`--year` 預設 115。

## 5. import 流程

discover → identify（P3.7 重用，內容辨識；檔名僅佐證）→ source gate
（meta URL＋P3.8 政策＋code 一致；無 meta 即 `source_unverified`）→
P3.7 parse＋validate → P3 normalize（語義不動）→ 4 份輸出。

## 6. status 意義

`imported`／`already_imported`（sha 相同）／`invalid_html`／`unidentified`
（P3.7 無結果）／`source_unverified`（無 meta 或驗證失敗）／`parser_error`／
`normalization_error`（含同 identity 重複）。失敗檔全列 errors.json。

## 7. Provenance

每筆 canonical 帶 sourceUrl（meta canonical URL）＋dataVersion；
整批帶 parser/normalizer 版本。無 meta 的檔案不進 official，只列報告。

## 8. Duplicate handling

同 sha→`already_imported`；同 identity 不同檔→`normalization_error`。
重跑冪等（輸出確定性排序；時間戳除外）。

## 9. 如何重新執行

直接重跑 CLI 即可，不動 raw、不寫 DB。`--refresh` 不適用本層
（無 cache 概念；每次全掃，sha 去重保證冪等）。

## 10. 不會自動連線 CAC

本目錄＋CLI 無任何 fetch/axios/curl/puppeteer（有 automated test 鎖定：
monkey-patch fetch 執行全流程＋原始碼關鍵字掃描）。
DB 寫入：本層不寫；正式入庫請走既有 P2 importer 安全介面（另案）。
