# Admission AI｜升學輔助平台

> **產品定位**：Admission AI 是升學輔助平台，落點分析只是其中一個功能模組，
> 不是整個專案。平台目前處於**資料基礎建設階段**：不提供錄取機率、不宣稱
> 任何模型準確率、不提供選填建議。

## 產品願景

以官方招生資料為基礎，長期提供四類彼此獨立的功能（皆須各自驗證，不可混為一談）：

| 功能 | 說明 | 狀態 |
|---|---|---|
| 客觀錄取機率 | 以歷史分數與招生名額為基礎的統計估計，須經回測驗證 | 規劃中 |
| 適合程度 | 科系與考生興趣／能力的匹配參考，非機率 | 規劃中 |
| 學習歷程證據 | 審查資料項目整理，協助考生盤點佐證材料，不評分 | 規劃中 |
| 申請文章分析 | 備審文件結構檢查輔助，不代寫、不保證效果 | 規劃中 |
| 落點分析 | 個人分數與歷史分布的比對參考（平台模組之一） | 規劃中 |

**名詞紅線**：文件中「落點」「機率」「適合」「推薦」不可混用；
任何未經回測的數字一律不得稱為準確率。

## 功能模組與實作狀態（以程式碼為準）

| 模組 | 位置 | 狀態 |
|---|---|---|
| 資料庫 schema／migration／seed | `db/` | 已實作 |
| 官方簡章 CSV 解析與 import pipeline | `src/data/importers/official/application115/` | 已實作 |
| 招生 detail HTML 解析（layout-A／B） | `src/data/importers/official/application115/detail/` | 已實作（術科 `table.tech` 變體二階提取已知缺口，見下） |
| Acquisition（單分頁 CDP、PENDING／LOAD_REQUIRED） | `src/data/acquisition/`、`scripts/admission-acquire.ts` | 已實作 |
| 學校／系組 inventory（10 校、496 筆、010 不存在） | `src/data/discovery/official/application115/pdf-inventory.ts` | 已實作 |
| Normalization（DB 來源、dry-run、reconcile） | `src/data/normalization/admission115.ts`、`scripts/normalize-admission-115.ts` | 已實作 |
| Import run 追蹤 | `data_import_runs`（`src/data/importers/.../index.ts`、`scripts/normalize-admission-115.ts --import`） | 已實作 |
| 資料驗證（8 項） | `scripts/validate.ts` | 已實作 |
| Prediction 介面 | `src/server/prediction/`（僅 types，一律回 null + 警告） | 介面佔位，未實作模型 |
| 學生／志願 domain types | `src/domain/student/` | types only |
| 落點 UI、AI 聊天、embedding、機率模型 | — | 規劃中（不存在） |

## 目前實際進度

- P1：schema／migration／seed／validation／prediction 介面 — 完成。
- P2：官方 CSV import pipeline（含 `data_import_runs` bookkeeping）— 完成。
- P3：115 學年度 10 校共 **496/496 LOADED**（001=73、002=58、003=51、004=65、005=25、006=47、007=32、008=43、009=45、011=57；010 官方不存在），pending=0、failed=0。
- P3.5：inventory 擴充（004~009、011）+ regression tests — 完成。
- P4（001~003，182 筆）：normalization + reconcile import + gate — PASS。
- P4.1（全庫 496）：dry-run 發現 **2 筆缺口**，gate FAIL（見下），未 import。

### 已知缺口（P4.1 dry-run 發現，未修）

`008432`、`009432`（術科系，`table.tech` 版面）：一階學測格全為 `--`
（純術科篩選，來源真值），但二階（審查／術科百分比）存在於來源卻未被
layout-B parser 提取。規則維持嚴格（未放寬），待 parser 支援後再以
LOAD_REQUIRED 通道針對該 2 筆重載。本階段禁止為通過而改規則或手寫資料。

## 技術架構

- Next.js 14 + TypeScript + ESLint + Prettier
- PostgreSQL on Neon（app 用 `@neondatabase/serverless`，migration／scripts 用 `pg`）
- Raw SQL migrations（可重複部署，`schema_migrations` 追蹤；`005` 僅冪等 DML）
- Scripts：`admission:acquire`、`admission:queue`、`p4:normalize`（預設 dry-run）、`validate`
- 測試：vitest（366 項）；`npm run typecheck`、`eslint` 全綠為合併前門檻

## 資料可信度原則

- **官方資料優先**：甄選會 CAC、大考中心 CEEC、分發會 UAC、各大學官方；`com.tw` 僅競品／結構／交叉驗證，未授權不進商業 DB（見 `docs/data-sources/source-policy.md`）。
- **來源追蹤**：重要資料保留 `source / source_url / academic_year / retrieved_at / parser_version / data_version`（`data_sources` 部分歷史列 `retrieved_at` 仍為 NULL，屬已知待補項，不影響現行流程）。
- **缺漏值語意**：null = 缺漏，永不補 0；選填資料（如 APCS）缺漏記 warning，不當 error。
- **驗證優先**：acquisition 按狀態機重試、normalization 附 raw 重 parse 比對、import 採 skip-if-identical reconcile；驗證失敗即停，不繞過、不硬塞。

## MVP 資料範圍

- 制度：大學個人申請（`program_type=application`）；考試：學測（欄位不寫死）。
- 年度為資料不寫死；school／department／program 分離；同校系不同年度為不同 record。
- Seed 僅放 `research_only` 測試資料（`TEST-*`），絕不混充官方資料。

## 快速開始

```bash
npm install
cp .env.example .env.local   # 填入 Neon DATABASE_URL（絕不 commit）
npm run db:migrate
npm run db:seed
npm run validate
npm run dev
```

唯讀檢查：`npm run admission:queue`、`npm run p4:normalize`（預設 dry-run，不寫 DB）。

## 開發限制（現階段不做）

落點 UI、錄取機率計算與宣稱、模型準確率宣稱、AI chatbot、OpenAI API、
embedding、爬 com.tw、大量爬蟲、任何 P4.1 gate FAIL 下的正式 import、
以及為通過驗證而放寬規則或手寫資料。
