# CAC 115 Detail HTML（P3.7）

> 「P3.7 僅解析已取得的官方 HTML fixture，不進行批量抓取，也不繞過 robots.txt。」
> cac.edu.tw robots 全站 `Disallow: /`，P2.5 crawler 維持拒絕批量；本 PoC 只讀
> 4 個人工指定的本機 `.htm`（001012／001022／001032／001592，另有 001013 經查 404 不存在）。

## CAC detail HTML 結構

行動版明細頁（`.../html/115_XXXXXX.htm`，HTML 4.0，標楷體列印頁）由 5 個
可收合 section 組成，以 `tr[id]` 錨定：

| id | 標題 | 內容結構 |
|---|---|---|
| BASIC | 基本資料及時程 | 2 欄 label→value 表（校系代碼／名額／性別／預計甄試／三種外加／費用／通知／收件／甄試日／榜示／複查／離島限制） |
| G_GRD | 學測、英聽篩選及採計 | 科目矩陣（科目／檢定／倍率／採計方式／佔比 rowspan／指定項目／檢定2／佔比2）＋超額篩選內嵌表＋APCS 內嵌表（僅特殊組） |
| G_CMP | 同分參酌 | `一、二、三…` 條列 |
| step_sn | 指定項目內容 | `#step_sd` 審查資料（項目：／說明：）、`#step_st` 甄試說明（數字條列） |
| step_no | 備註 | 數字條列 |

注意：頁內 HTML 註解藏有模板佔位符（centertimes／telclowest 等），parser 只查
真實 section 自然排除；validator 另有 artifact 检查，佔位符外洩即 error。

## 欄位 mapping

- 基本：校系代碼→departmentCode（前 3 碼→schoolCode）、名額→quota、
  預計甄試→expectedInterviewCount、外加→extraQuotas、費用→applicationFee（整數）、
  各日期→原字串保留（`115.5.15` 不轉 Date，保真）。
- 一階：每科（檢定／倍率／採計方式）；學測佔比（rowspan 首列）→overallFirstStageWeight；
  超額篩選→overQuotaRules[]；APCS→apcs{items, note}（僅 001592 類有）。
- 二階：指定項目／檢定2／佔比2→secondStageItems[]；審查項目／說明、甄試說明分開存。
- 缺欄→null/[]＋warning；`--`/`無`/`(無)`→null；絕不填 0。

## Parser strategy

`node-html-parser` DOM＋label→value＋section 錨定；`<br>`→`\n` 後切編號條列；
entity 顯式解碼；全形空白正規化；rowspan 偏移以「每列最後三格＝二階欄」吸收；
最內層匹配（嵌套表不取外層 wrapper 文字）。未知 BASIC label 進 unmapped＋warning。

## Missing-value / provenance

沿 P3：missing≠0。 provenance：source=official、sourceUrl（檔名反推官方 URL）、
academicYear=115、retrievedAt（fixture 省略→null）、parserVersion、
dataVersion。`toP2Row`／`toP3Input` 只帶 P2/P3 已有語義的欄位；
`screening_ratio_1..3` 故意 null（明細倍率是每科倍率，非 P2 的輪次序）。

## Fixture

`tests/fixtures/official/application115/detail/`：4 組 `.htm`（約 22KB/個，
僅測試必需）＋同名 `.expected.json`（parser 輸出凍結比對）。
001013 經查 404（不猜碼，已記錄）。

## 已知特殊案例

- 001022：英聽列（A級）、rowspan=7、超額 4 條。
- 001592（APCS 組）：僅 3 科目列、APCS 內嵌表（觀念題 4級／實作題 4級＋5倍率）、
  grade 矩陣 4 列空白 padding（記 warning，不當錯）。
- 模板註解、`<br>` 黏合、rowspan 首列是三個已處理的結構陷阱。

## Robots / crawler policy

P2.5 crawler 未動（仍拒批量）；本 PoC CLI 只接受明確指定的本機檔，
無下載、無掃描、無 DB 寫入。輸出 `data/processed/.../detail/*.json`（gitignored）。
