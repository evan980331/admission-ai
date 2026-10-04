# P3.11 Local Import（全離線：人工下載 → 本機辨識 → 驗證 → 解析 → 正規化）

```
data/raw/official/115/application/*.htm
  → discover（遞迴，只收 .htm/.html；禁 .pdf/.json/.meta.json）
  → identify（P3.7 重用，內容辨識；檔名僅佐證）
  → source gate（P3.9 .meta.json＋P3.8 URL 政策＋code 一致；無 meta 即 source_unverified）
  → P3.7 parse＋validate → P3 normalize（語義不動）
  → data/processed/official/115/local-import/（gitignored）
```

- 零網路（本目錄＋CLI 無 fetch；有 automated test 鎖定）。
- 不寫 DB、不改 raw；重跑冪等（sha 去重＋確定性排序；時間戳更新除外）。
- source_unverified／unidentified／parser_error 等狀態皆入 errors.json，不靜默丟檔。
