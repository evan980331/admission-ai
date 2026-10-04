# Official 115 Dataset Build（P3.13，本地累積，離線）

## 流程

```
P3.11 local import（raw 目錄掃描＋P3.7＋P3）
  → dataset merge（identity＋sha 版本化）
  → dataset.json / coverage.json / errors.json / build-report.json
```

## Identity / merge 規則

- key＝`academicYear|schoolCode|departmentCode`；輸出 key 排序，deterministic。
- 同 key＋同 sha→unchanged（沿用舊 entry）；同 key＋異 sha→舊版記
  `superseded` 入 history，新版狀態 content_changed；源檔消失→舊 entry
  保留但狀態 `carried`（另計，不計入 captured／unchanged／normalized；
  universe 內無現行源者亦計 missing）。絕不靜默覆寫／刪除。
- 同 run 內同 key 重複→第一筆保留，其餘記 normalization_error。
- dataVersion：entry 沿用 P3.7/P3.11 解析層版本；canonical 沿用 build 參數版本。

## Provenance

entry 帶 sourceUrl（meta canonical URL；無 meta 者 null，狀態
source_unverified，絕不填 `local-file:` 假裝驗證）、capturedAt、sha256、
parserVersion、dataVersion；sourceType 恆為 official。

## Coverage

universe 來自 `--universe <P3.8 department-manifest.json>`（缺席不發明；
無 universe 時 missing＝0）。計數分兩維（允許重疊，已文件化）：
時效維 captured／unchanged／content_changed／carried／missing、
處理維 parse_success／parse_error／validation_error／normalized／
normalization_error。carried＝有資料但本次無源；missing＝universe 內無現行源
（含 carried）。狀態：captured／unchanged／content_changed／
parse_success／parse_error／validation_error／normalized／
normalization_error／missing。

## 增量行為

第二次跑同一輸出目錄會讀既有 `dataset.json` 續併；成功資料不受後續
失敗影響；`--dry-run` 零寫入。

## CLI

```bash
npm run data:build-official-dataset -- --dry-run
npm run data:build-official-dataset -- --input <raw dir> --output <out dir> --universe <manifest.json>
```

只讀本機、不聯網、不寫 DB。DB 寫入沿用既有 P2 importer 安全介面（另案）。
