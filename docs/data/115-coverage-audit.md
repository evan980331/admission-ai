# 115 Coverage Audit（P1-C.2）

> universe source incomplete — 本報告的 universe 是「已驗證、可 code-identified 的
> 片段下限」，不是 115 個人申請總校系數。repo 內無 TotalGsdShow／school-index raw，
> 不推估總數。數字來自 `scripts/audit-115-coverage.ts` 實跑（offline、無抓取、
> DB 只讀），非硬編碼；machine-readable JSON 以 `--out` 產出（不進版控）。

## 1. Universe 來源（2026-10-05 實跑）

| 來源 | 內容 | 角色 |
|---|---|---|
| `data/raw/.../departments/` | 115_001012＋115_001022（htm＋meta，official） | EXPECTED＋RAW |
| DB masters（只讀） | 001／001012／001022；TEST-* seed 列已排除（research_only 不進 universe） | EXPECTED |
| `tests/fixtures/.../detail/` | 001012／001022／001032／001592（provenance=fixture，URL 為 mobile 版） | EXPECTED（fixture 標記） |
| P3.5 PDF 系碼數（001→73、002→58、003→51） | 僅計數，無系碼清單 | 外部佐證，不入 universe |

合併鍵：`academicYear|schoolCode|departmentCode`；名稱差異不分叉 identity；
detailUrl 只收已觀測值（meta／fixture），不構造。

## 2. Coverage（universe=4）

| code | flags | status | provenance |
|---|---|---|---|
| 001012 | EXPECTED＋RAW_AVAILABLE＋PARSED＋DATASET_PRESENT＋DB_PRESENT＋CANONICAL_COMPLETE | complete | official |
| 001022 | 同上六項 | complete | official |
| 001032 | EXPECTED＋PARSED＋CANONICAL_COMPLETE＋NEEDS_ACQUISITION | needs_acquisition | fixture |
| 001592 | 同上 | needs_acquisition | fixture |

統計：raw 2／parsed 4／dataset 2／db 2／canonical 4；
NEEDS_ACQUISITION 2、NEEDS_PARSE_FIX 0、NEEDS_SCHEMA_MAPPING 0；
缺口學校：001（2 系：001032、001592）。
P1-C.1 regression：001012／001022 皆六旗 complete ✓。

## 3. Identity consistency

- schoolCode 一律等於 dept[:3]（P3.12 規則）；檔名 `115_` 是年份前綴，永不當校碼。
- 本輪實證：審計抓到 `115_001012.htm.meta.json` 殘留 `schoolCode=115`
 （P3.12 修法前的舊 capture；code 已正規化為 001，mismatch 列入報告
  `metaMismatches`；以 CDP 重收即痊癒，不手改 raw）。
- desktop URL query 原樣保留（`?v=1.0` 無警告）；fixture mobile URL 僅 warning
  （provenance 差異，非錯誤）；非官方 host／URL-code 不一致為 error（本輪 0 件）。

## 4. Schema gap audit

- parser→canonical：三 fixture `auditCanonicalCompleteness` errors=0，無缺口。
- canonical→DB：8 節皆有 migration 表（靜態斷言），NEEDS_SCHEMA_MAPPING=0。
- 已知未入 canonical 槽：interviewNotes（audit warning，後續 phase）。

## 5. 下一步（acquisition 唯一規劃依據）

1. 最高優先：人工取得 TotalGsdShow＋各校 ShowSchGsd（瀏覽器另存，合法），
   建真實 universe manifest；在此之前不得引用任何總數。
2. 次之：001032、001592 desktop capture（用户單頁節奏，禁並行／禁猜 URL）。
3. 順帶：CDP 重收 001012 desktop（清除 stale meta 的 `schoolCode=115`)。
4. robots 全站 `Disallow: /` 維持 fail-closed；UTW 僅交叉驗證，不進 universe。

## 6. 重跑方式

```bash
npx tsx scripts/audit-115-coverage.ts --out <path>.json
```

讀寫說明：讀 raw／fixtures／migrations；DB 僅在 `DATABASE_URL` 存在時只讀
（缺席則 db=null＋理由，不猜）；不寫 DB、不寫 raw、不印 secret。
