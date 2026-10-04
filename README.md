# Predicter｜台灣大學升學落點預測／決策系統

> P1 基礎建設階段：建立可長期使用的 GitHub + Neon + PostgreSQL + data pipeline 基礎。
> 現在**不是**落點查詢網站，不提供錄取機率、不宣稱準確率。

## 目的

長期核心鏈路：

官方招生資料 → 歷史資料 → 統計模型 → 當年度考生行為 → 個人錄取機率 → 志願組合最佳化

第一階段只做可靠資料層與資料庫，不做推薦模型、AI 聊天、embedding。

## 技術架構

- Next.js 14 + TypeScript + ESLint + Prettier
- PostgreSQL on Neon (`@neondatabase/serverless` for app, `pg` for migrations/seeds)
- Raw SQL migrations in `db/migrations/`（可重複部署，`schema_migrations` 追蹤）
- Seed: `db/seed.ts`（僅 research_only 測試資料）
- Validation: `scripts/validate.ts`（8 項檢查）
- Prediction: `src/server/prediction/`（現階段只有 types／介面，一律回傳 null + 警告）

## 資料來源策略

- PRIMARY（官方優先）：大考中心 `https://www.ceec.edu.tw/`、大學甄選入學委員會 `https://www.cac.edu.tw/`、大學考試入學分發委員會 `https://www.uac.edu.tw/`
- SECONDARY：各大學官方招生資料
- RESEARCH ONLY：`https://www.com.tw/` — 僅競品研究、資料結構研究、交叉驗證；未確認授權前不複製進商業資料庫

詳見 `docs/data-sources/source-policy.md`。

## MVP 資料範圍

- 制度：大學個人申請（`program_type=application`）
- 考試：學測（`exam_type=gsat`），欄位不寫死，未來可加分科／統測
- 歷史：111–115（年度為資料，不寫死在程式邏輯）
- schema 支援全台所有校系；seed 只放 2–3 所測試大學

## 快速開始

```bash
npm install
cp .env.example .env.local   # 填入 Neon DATABASE_URL（絕不 commit）
npm run db:migrate
npm run db:seed
npm run validate
npm run dev
```

Neon（需本機 `neon login` 瀏覽器授權後）：

```bash
npm i -g neon@latest
neon link --project-id blue-union-44034956 --branch production -y
neon config init
neon deploy
```

Secrets 只允許出現在 `.env.local`／本機環境／Neon secret 管理。

## P1 / P2 階段

- P0 市場研究：`docs/research/P0-market.md`
- P1/P1.5 資料源規劃：`docs/research/P1-data-sources.md`
- P1 本階段：schema + migration + seed + validation + prediction 介面
- P2（下一步）：官方簡章 parser、import pipeline、data_import_runs 監控、統計模型 v0

## 本機資料管線（P3.11，全離線）

人工下載 CAC 官方 HTML → `data/raw/official/115/application/` →
`npm run data:import-official-local -- --dry-run` →
詳見 `docs/data-sources/official-115-local-import.md`。零網路、不寫 DB。

## 限制（本階段不做）

落點 UI、AI chatbot、OpenAI API、embedding、爬 com.tw、大量爬蟲、錄取機率宣稱。
