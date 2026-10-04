# Official 115 Manifest（P3.8）

> 「P3.8 不執行批量 detail page download，不繞過 robots.txt。」
> cac.edu.tw robots 全站 `Disallow: /`；P2.5 crawler 維持拒絕批量。
> 本層只把**已在本機的官方索引 HTML**轉成 manifest，不發任何請求。

## CAC hierarchy

```
TotalGsdShow.htm（64 校，每校 ShowSchGsd.php?colno=XXX 連結）
  → ShowSchGsd.php（該校系組，每系 detail 連結 .../html/115_XXXXXX.htm）
  → department manifest（校→系→detailUrl）
```

## 文件與 schema

- `OfficialSchoolManifest`：年度／校碼／校名／校頁 URL／source＋所屬 departments。
- `OfficialDepartmentEntry`：年度／校碼／校名／校頁 URL／系碼／系名／
  detailUrl（canonical 絕對 URL）／sourceUrl（發現頁）／sourceType=official／
  discoveredAt／status=discovered／urlValidation。
- 輸出（gitignored，不進 repo）：`school-index.json`、
  `department-manifest.json`（`{academicYear, source, sourceUrl, count, departments[]}`，
  count 來自實際資料）、`manifest-report.json`。

## URL validation

`new URL()` 解析後驗證：協議 http(s)、host 必須 `www.cac.edu.tw`、
路徑屬於 `/apply115/` 或 `/mobile_apply115/`（同官方樹的桌機／行動版）、
檔名 `<year>_<6碼>.htm` 且 year=115、code 與 entry 一致。
拒絕：javascript:、第三方域、站外 scope、相對路徑無法 canonicalize、
年份不符。另有 `detailUrl 唯一` 檢查。

## Provenance / duplicate / missing-data

- 每 entry 帶 sourceUrl＋discoveredAt；整批帶 manifestVersion。
- duplicate school／dept／URL、校碼前綴不一致、code/URL 不一致、空名、
  空 URL：error（URL 問題）或 warning（缺資料），绝不靜默修正。
- P2.5 parser 已去重並報錯者，以 `p25:` 前綴併入報告（單一真相源，不分叉）。

## P2.5 / P3.7 整合

- P2.5＝acquisition（下載＋cache＋robots gate）；P3.8＝manifest（domain 層）；
  P3.7＝detail 解析；P3＝normalization。P3.8 不下載 HTML。
- `manifestEntryToDetailInput` 輸出 P3.7 CLI 可直接吃的三元組
 （departmentCode／sourceUrl／expectedFilename），已用真實 001012 fixture 測通。
- 真實 manifest 需 P3.9 以合規方式取得 TotalGsdShow＋各校頁後，
  `npm run data:build-official-manifest -- --total <file> --school-dir <dir>` 產生。

## Robots policy

CLI 缺輸入即 exit 2，絕不上網補抓；本目錄無任何 fetch 程式碼
（驗證方式：grep 全目錄無 `fetch(`／`http.get`）。
