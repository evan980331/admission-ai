# Historical Normalization（P3）

P2/P2.5 建的是「官方資料怎麼進來」；P3 建的是「進來之後如何變成模型可用的歷史語言」。
本層不做機率、不做預測，只做**標準化＋品質標記**。

## 1. Canonical historical record

`src/data/normalization/types.ts` 的 `CanonicalHistoricalRecord`：
年度／管道／校碼／系碼／系名、quota／applicants／screened／secondStage／
admitted／waitlisted、minimumScore／averageScore、sourceId／dataVersion。
除 identity 四元組外，其餘全可為 `null`；**禁止用 0 代替未知**（沒有資料 ≠ 0）。

## 2. 年度制度差異

`normalize-year.ts`：111–115 皆為 108 課綱學測體制（`gsat-108-curriculum`），
`comparableWith` 互列，意義是「體制可互相參照」，**不是**「分數可直接比較」。
未知年度 → metadata 為 null → 引用級（reference-only）＋ warning。
若將來要把 metadata 存進 DB 才需要 migration；目前放程式碼層，**schema 未修改**。

## 3. Department identity

key = `school_code|department_code|program_type|academic_year`，永不用純名稱。
- 同碼跨年 → matched（改名記入 notes，不靜默合併）
- 候選多筆 → ambiguous＋warning，需人工確認
- 換碼／找不到 → unresolved，獨立保留，**絕不自動合併**

## 4. Score normalization

`normalize-score.ts`：保留原始值（rawScore/grade），percentile/normalizedScore
只有在分布表或 mean+sd 存在時才計算，否則 null＋方法名留痕。
跨年比較一律 `comparable=false`；`scoresComparable` 要求同年＋同方法。
原因（第 8 節）：難度、級距、篩選規則每年都變，原始分數跨年不可比。

## 5. Missing value policy

`missing`（未知→null）／`zero`（明確 0，如停招）／`not_applicable`／`unknown`
（無法解析→null＋error，如 `"N/A"`）四態分離；`"--"`、`"無"`、空字串視為 missing。

## 6. Quality warning/error policy

- error：identity 缺碼、負數、不可能格式、重複 identity。
- warning：`admitted > quota`（特殊名額／回流／定義差異可能，不自動駁回）、
  screened > applicants、缺值、ambiguous、merge 差異。
- quality 檢查不刪資料，只標記；嚴重 error 的 row 不進 canonical（但仍計入 report）。

## 7. Provenance

每筆 canonical 帶 `sourceId`＋`dataVersion`；整批帶
`historical-normalization-v0.1.0`。報告
`data/processed/historical/<year>/normalization-report.json`
（gitignored，不進 repo）含 input/normalized/warnings/errors/ambiguous 計數。

## 8. 為什麼不能直接比較不同年度原始分數

學測題目難度、級分人数分布、校系名額、篩選倍率、檢定標準每年皆變；
同一個「均標」在不同年代表不同 PR 值。P3 只提供年度內標準化
（grade passthrough／percentile／zscore）與 `scoreGap = candidate − threshold`
的 deterministic 計算；跨年可比性是 P4 要解的校正問題，不是 P3 假裝已解。

## 9. P3 → P4 資料流

```
historical_results (DB, read-only SELECT)
  → normalizeHistoricalBatch → canonical-records.json (gitignored)
  → quality issues → normalization-report.json
  → P4 Feature Engineering 取 canonical + scoreGap + percentile（只用 comparable=true 者）
  → Backtesting 取多年度 canonical（以 comparableWith 決定參照範圍）
```

P4 不得回寫 P3 canonical；特徵一律衍生、不覆蓋原始 null。
