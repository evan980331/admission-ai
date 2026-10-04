# AGENTS.md — Predicter 工作準則

## 產品紅線
1. 不要做成單純落點查詢網站；長期核心是 官方資料→歷史→統計模型→當年度行為→個人機率→志願最佳化。
2. 官方資料優先；`com.tw` 僅競品／結構／交叉驗證，未授權不複製進商業 DB。
3. 所有重要資料保留 `source / source_url / academic_year / retrieved_at / parser_version / data_version`。
4. P1 不做 LLM / embedding / AI 聊天 / 複雜推薦模型 / 錄取機率宣稱。
5. 測試資料必須標 `research_only`，絕不假裝成官方資料。

## 資料庫準則
- 年度資料永不覆寫；同校系不同年度 = 不同 record。
- school / department / program 分離；年度、exam_type 不寫死在程式邏輯。
- 最低錄取分數不是唯一歷史欄位；migration 必須可重複部署。

## 工程準則
- Secrets 只進 `.env.local` / Neon secrets，永不進 Git。
- 先讀檔再改檔；小範圍 edit；改完跑 `typecheck + lint + test + build` 相關驗證。
- Commit 訊息：`feat: ...` / `fix: ...` 簡潔英文；本階段首次 commit 為 `feat: initialize predicter data platform`。

## 常用指令
- `npm run dev` / `npm run build` / `npm run lint` / `npm test`
- `npm run db:migrate` / `npm run db:seed` / `npm run validate`
