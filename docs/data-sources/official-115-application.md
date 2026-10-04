# 115 學年度大學申請入學 — 官方資料來源記錄

> P2 範圍限定：115 學年度 × 大學申請入學（`program_type = application`）。
> 本文件只記錄「哪裡有資料、能不能自動抓」；實際匯入一律走 `src/data/importers/official/application115/`，
> 強制 `SOURCE → DOWNLOAD/LOCAL INPUT → RAW → PARSE → NORMALIZE → VALIDATE → IMPORT → data_import_runs`，
> 且 parser 不得直接寫 DB。

## 0. 自動化存取檢查（2026-10-04，人工程式檢查一次，非 crawling）

| 網站 | robots.txt | 結論 |
|---|---|---|
| `https://www.cac.edu.tw/robots.txt` | `User-agent: *` ＋ `Disallow: /`（全站禁止自動抓取） | ❌ 不得對 cac.edu.tw 做任何自動下載／crawling |
| `https://www.ceec.edu.tw/robots.txt` | 不存在（404） | ⚠️ 無明確允許，採保守原則：人工下載 |
| `https://www.uac.edu.tw/robots.txt` | 僅 content-signals（AI 使用聲明），無爬蟲允許 | N/A（分發，非 P2 範圍） |

**P2 決議：所有 115 申請入學官方檔案一律「人工下載 → 本地匯入」模式。**
importer 不實作 `--url` 自動下載，只接受 `--input <local-file>`。
如未來官方 robots 政策改變，須先更新本文件才能開放自動下載。

## 1. 來源一：115 學年度大學申請入學 — 校系分則查詢（甄選會）

- source_name: `cac-115-application-dept-rules`
- source_type: `official`
- academic_year: `115`
- program_type: `application`
- source_url: `https://www.cac.edu.tw/apply115/query.php`
- 總覽頁：`https://www.cac.edu.tw/apply115/system/ColQry_115xappLyfOrStu_Azd5gP29/TotalGsdShow.htm`
  （64 所學校，共 2206 系組；每列含校系名稱及代碼、招生名額、預計甄試人數、外加名額、甄試費、甄試日期、詳細資料連結）
- 明細頁（行動版，每系一頁）：`https://www.cac.edu.tw/mobile_apply115/colqRy_Apply_8Rfsd57q/html/115_<校系代碼>.htm`
  （例：`115_001702.htm`＝臺大希望組戊組；含「基本資料及時程」表：校系代碼、招生名額、性別要求、預計甄試人數、
  原住民／離島／願景外加名額、甄試費、榜示／複查日期；以及審查資料、甄試說明、備註）
- data_format: `HTML`（官方未提供 CSV／JSON／XLSX 下載檔）
- available_fields: 校系代碼（6 碼，前 3 碼為學校）、校系名稱、招生名額、預計甄試人數、
  性別要求、外加名額（原住民／離島／願景）、甄試費、甄試日期、榜示日期、審查資料項目、甄試說明
- retrieval_method: `manual-download`（瀏覽器人工另存 HTML 到 `data/raw/official/115/application/`）
- license / usage note: 甄選會公開招生資訊，供考生查詢；僅作 Predicter 內部統計建模之用，不重新發布原始檔案。
- retrieved_at: 以實際人工下載日期為準，寫入 `data_sources.retrieved_at`（格式 `YYYY-MM-DD`）
- limitations:
  - HTML 為呈現導向，無穩定 schema；欄位列舉（如審查資料代碼 A–Q）以簡章文字為準，不猜測代碼含義。
  - 明細頁是否含「學測檢定標準／第一階段篩選倍率」表依各校而異；parser 只映射確認存在的欄位，
    未映射區段一律記為 warning，不靜默丟棄。

## 2. 來源二：115 學年度各校系篩選標準一覽表（甄選會）

- source_name: `cac-115-application-screening`
- source_type: `official`
- academic_year: `115`
- program_type: `application`
- source_url: `https://www.cac.edu.tw/CacLink/apply115/115Apply_sievE_Result_querY_615JG8Wgh9d/html_sieve_result_115_Zx57f1dW/Standard/collegeList.htm`
  （下掛各校一覽表；建議先讀「篩選示例摘要」理解篩選程序）
- data_format: `HTML`（官方未提供結構化下載檔）
- available_fields: 各校系第一階段篩選倍率、學測檢定標準、篩選順序（實際欄位以人工下載檔案為準）
- retrieval_method: `manual-download`
- license / usage note: 同來源一。
- retrieved_at: 以實際人工下載日期為準
- limitations: 一覽表為跨校彙整頁，校系代碼對應需人工核對；倍率語義（如「3 倍率」之母數）以該頁示例摘要為準，不自行推導。

## 3. 來源三：115 學年度各校系分發標準一覽表（甄選會，第二階段後公告）

- source_name: `cac-115-application-distribution-standard`
- source_type: `official`
- academic_year: `115`
- program_type: `application`
- source_url: `https://www.cac.edu.tw/CacLink/apply115/115AppLy_Entrance6_xQuery_Oz9ft_5d43Yrw/html_115entrance_Yet9527ohR/standard_html/standard_index.php`
- data_format: `HTML`
- available_fields: 待第二階段放榜後公告；目前僅收錄 URL，不匯入。
- retrieval_method: `manual-download`（待公告後）
- license / usage note: 同來源一。
- retrieved_at: `pending`
- limitations: 尚未公告；P2 本輪不處理。

## 4. 非 P2 範圍（只記錄，不匯入）

- 大考中心五標／級分人數分布（`exam_type = gsat`）：屬分數統計層，P2 只做招生資料，不匯入。
- 繁星／分科／分發／科大申請／統測：全部不在本輪。
- `com.tw` 及其他第三方落點網站：永遠不得作為正式資料來源（見 source-policy）。

## 5. Provenance 慣例（本輪）

- `data_sources.source_name` = 上列三者之一；`source_type = official`；`source_url` = 實際下載頁 URL。
- `parser_version` = `application115-parser-v0.1.0`（見 importer 常數 `PARSER_VERSION`）。
- `data_version` = `manual-<YYYY-MM-DD>`（人工下載批次日期，可用 `--data-version` 覆寫）。
- RAW 保存於 `data/raw/official/115/application/`；解析後與報告保存於 `data/processed/official/115/application/`。
