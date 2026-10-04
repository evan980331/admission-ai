# CAC Official Detail Parser PoC（P3.7）

解析 CAC 行動版校系明細頁（`115_XXXXXX.htm`）為結構化 `DetailRecord`。
**僅處理已取得的本機 HTML fixture；無抓取、無 DB 寫入、不碰 robots/crawler。**

## 用法

```bash
npm run data:parse-official-detail -- --input tests/fixtures/official/application115/detail/115_001012.htm
```

輸出 `data/processed/official/115/application/detail/115_001012.json`（gitignored）。

## 策略

- DOM 解析（`node-html-parser`），以 section id 定位：
  `#BASIC`（label→value 二欄表）、`#G_GRD`（科目矩陣＋超額篩選＋APCS）、
  `#G_CMP`（同分參酌）、`#step_sd`（審查資料）、`#step_st`（甄試說明）、
  `#step_no`（備註）。HTML 註解內的模板佔位符（centertimes 等）因只查
  真實 section 而自然排除；validator 另有 artifact 檢查。
- `<br>` 轉 `\n` 再做編號切分；全形/半形、`&nbsp;`、多餘空白正規化。
- 缺欄 → null/[]＋warning；絕不填 0、絕不猜值。
- `screening_ratio_1..3` 故意留 null：明細頁的倍率是「每科倍率」，
  不是 P2 的第 1/2/3 輪篩選序，硬塞會造假；完整每科倍率保留在 detail JSON 供 P4。

## 接軌

- `toP2Row` → P2 CSV 列形（requirements＋quota＋expected counts）。
- `toP3Input` → P3 `RawHistoricalInput`（quota 攜帶，其餘 null）。
- 兩者皆不改 P2/P3 語義。
