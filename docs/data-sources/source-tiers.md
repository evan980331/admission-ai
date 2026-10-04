# 資料來源分級（source tiers）

P3.6 起，Predicter 明確區分三級來源。第三方永遠不能提升為官方，
官方永遠是唯一 authoritative。

## official（高可信，唯一 authoritative）

- CAC（甄選會／分發會）、大考中心、各大學官方招生公告、官方 PDF。
- 用途：正式資料層、模型訓練、交叉驗證基準。
- 衝突時：official 勝出，第三方僅保留作 discovery。

## third_party（結構化，僅驗證／探索）

- `University TW`（`https://university-tw.ldkrsi.men/caac/`）。
- robots：僅禁 `/search`、`/go-to/`；學校／系組頁可正常 GET（2026-10-04 確認）。
- 站方自述限制（見其備註欄，不收錄）：
  術科校系、APCS／資安組、性別限制校系、外加名額資訊；
  且「查詢結果僅供參考，若與簡章內容不符，概以正式簡章為準」。
- 用途：快速取得結構化 115 欄位（系碼／名稱／quota／檢定／倍率／114 參考）、
  與官方 PDF 做差異探索。**不得寫入正式 DB，不得覆蓋官方列。**
- provenance：`sourceType=third_party`、`sourceName=University TW`、
  `sourceUrl=原頁面 URL`，每筆必帶。
- 使用條件：站上未見授權／授權條款頁，僅有「僅供參考」聲明。
  因此只做最小範圍比對（001／002／003），不批量、不存原始 HTML 進 repo、
  不重新發布其內容。**正式商用前需進一步確認使用條件**。

## research_only（僅研究）

- com.tw（競品／結構研究）、測試 seed、fixture。
- 不得進入正式資料層；seed 與 fixture 必須明確標記。

## 來源 vs 用途矩陣

| 來源 | 正式 DB | 模型訓練 | 交叉驗證 | 探索 |
|---|---|---|---|---|
| official | ✅ | ✅ | ✅（基準） | ✅ |
| third_party | ❌ | ❌ | ✅（被驗證方） | ✅ |
| research_only | ❌ | ❌ | 結構參考 | ✅ |
