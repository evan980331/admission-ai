# P3.10 Coverage Audit（全離線，不聯網、不寫 DB、不改 raw）

掃描本機已有物：`data/raw`（PDF 清單）、`data/processed`（reports＋detail JSON＋
canonical）、`tests/fixtures`（detail .htm 現場解析、UTW codes）。
缺輸入只警告，絕不自動補抓。

`parsedDetails` Map 的 value 型別見 `coverage.ts` `ParsedDetailShape`；
`unknown` 永不等於 false；`not_applicable`（如無 APCS 的系）不計 missing。
