# 資料模型（data-model）

- `schools` 1—N `departments`：校與系分離，`departments(school_id, department_code)` 唯一。
- `admission_programs(year, program_type)`：年度 × 管道（如 115 × application）。
- `department_admissions(year, department_id, program_id)` 唯一：該年度該系該管道一筆，不覆寫歷史。
- `historical_results`：quota / applicants / screened / second_stage / admitted / waitlisted + min/avg score。
- `score_statistics`：五標 `(year, exam_type, subject)` 唯一；不把學測寫死。
- `score_distributions`：級分人數分布 `(year, exam_type, subject, score)` 唯一。
- `admission_preferences`：志願偏好計數。
- `data_sources(source_type ∈ official/university/third_party/user_report/research_only)` + `data_import_runs` + `model_versions`：provenance 與可重現性。
- 索引：見 `db/migrations/001_initial_schema.sql`（dept / year / exam / subject）。
