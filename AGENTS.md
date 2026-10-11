# AGENTS.md — Admission AI 工作準則

## 長期產品原則（跨階段不變）

1. 本專案是「Admission AI 升學輔助平台」，落點分析只是其中一個模組；
   不要做成單純落點查詢網站，也不要把規劃中的功能寫成已完成。
2. 「客觀錄取機率／適合程度／學習歷程證據／申請文章分析」是四個獨立功能，
   各自需要獨立驗證；名詞不可混用，未經回測的數字不可稱為準確率。
3. 官方資料優先；`com.tw` 僅競品／結構／交叉驗證，未授權不複製進商業 DB。
4. 所有重要資料保留 `source / source_url / academic_year / retrieved_at / parser_version / data_version`。
5. null = 缺漏，永不補 0；選填資料缺漏記 warning，不當 error。
6. 測試資料必須標 `research_only`，絕不假裝成官方資料。
7. 驗證失敗即停：不繞過 validation、不手寫資料、不放寬規則求通過。

## 現階段任務（P4.1，2026-10 起）

- 範圍：115 學年度 10 校 496 筆 canonical 招生資料的 normalization dry-run。
- 現況：P4.1 gate FAIL——`008432`、`009432`（術科 `table.tech` 版面）二階
  未被 parser 提取（詳見 README「已知缺口」）。在 parser 支援前，
  **禁止** `--import`、禁止改規則、禁止手寫資料。
- 允許：唯讀稽核（`admission:queue`、`p4:normalize` 不加旗標）、加測試、
  修 parser（需另開任務並附 regression test，不可順手改）。
- 規劃中、現階段禁做：落點 UI、機率模型、AI 聊天、embedding、正式 import。

## 資料庫準則
- 年度資料永不覆寫；同校系不同年度 = 不同 record。
- school / department / program 分離；年度、exam_type 不寫死在程式邏輯；
  校碼以官方 inventory 明確列舉，禁止連號生成（010 不存在）。
- 最低錄取分數不是唯一歷史欄位；migration 必須可重複部署；
  005 類 masters 只做冪等 DML，不改既有列。

## 工程準則
- Secrets 只進 `.env.local` / Neon secrets，永不進 Git。
- 先讀檔再改檔；小範圍 edit；改完跑 `typecheck + lint + test` 相關驗證。
- 只改被指派範圍；不為了更新文件而動業務程式碼、schema 或他人未提交修改。
- 不得 reset、revert、commit、push（除非使用者明確指示）。
- Commit 訊息：`feat: ...` / `fix: ...` 簡潔英文。

## 常用指令
- `npm run dev` / `npm run build` / `npm run lint` / `npm test`
- `npm run db:migrate` / `npm run db:seed` / `npm run validate`
- `npm run admission:queue` / `npm run p4:normalize`（唯讀 dry-run）
