# Official Detail Acquisition PoC（P3.9）

> 「P3.9 是小批次 Acquisition PoC，不是完整資料抓取。」
> 上限 10 個 URL，全數來自 manifest；robots fail-closed，違者停。

## Architecture

```
P3.8 manifest entries
  → robots.txt gate（P2.5 evaluateRobots，fail-closed）
  → serial paced GET（P2.5 Pacer＋fetchWithMeta）
  → response validation（status／content-type／final host／scope／檔名-code／body 標記）
  → raw cache（htm＋.meta.json：url／時間／狀態／sha256）
  → P3.7 parse＋validate（不寫 DB）
  → acquisition-report.json
```

P2.5 基礎設施全重用（adapter re-export）；唯一新增是 P2.5 client 的
additive `fetchWithMeta`（回傳 status/headers/finalUrl/bytes，
`fetchText` 行為不變，P2.5 測試全過可證）。

## Manifest dependency

PoC batch 目前固定 4 個**已驗證** URL（001012／001022／001032／001592，
P3.7 已成功 GET＋解析；001013 經查 404 故不用，不猜碼）。
`runAcquisition` 仍強制全部 entries 走 P3.8 `buildManifest` 驗證，
非法 URL 直接剔除＋`manifestErrors` 入報告。

## Robots policy

- 先取 robots.txt（單一合規請求，可 cache），`Disallow: /` → 全頁
  `ROBOTS_BLOCKED`＋exit 3（政策性停止，非程式錯誤）。
- 誠實 UA，不偽造、不 parallel（concurrency=1）、不 proxy/mirror、
  不拿搜尋引擎快取當來源。

## Request limits

concurrency=1、timeout 15s、retry 2（僅 408/429/5xx）、間隔 ≥2s、
`--limit` 上限 10、`--code` 僅限 batch 內、任意 URL 拒收。

## Cache / provenance

命中預設不重抓（`--refresh` 才重抓）。meta 含 url／retrievedAt／httpStatus／
contentType／sha256／bytes；raw 與 report 全 gitignored。

## Response validation / failure handling

200≠成功：另驗 content-type、final host、scope、檔名-code 一致、body 含
CAC 標記（校系代碼／招生名額／基本資料及時程）。404→invalid（不重試風暴），
超時／斷線→failed；失敗如實入報告，不假裝成功。

## Parser integration

快取或新抓的 HTML 都走 P3.7 parse＋validate；parse 失敗記 `parse_failed`，
不寫 DB。PoC 驗證：001012 全欄位、001592 APCS。

## Legal / operational constraints

- 第三方來源不用於正式 manifest；UTW 僅驗證／探索（見 source-tiers）。
- 商用前需確認各站使用條件；完整 2200＋ 抓取不在本階段。
