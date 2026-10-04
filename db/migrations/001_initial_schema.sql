-- 001_initial_schema
-- Predicter P1: long-lived PostgreSQL schema. Re-runnable (IF NOT EXISTS).
-- Principles: keep every academic year; school/department/program separated;
-- every important row keeps provenance (source_id where applicable).

-- ---------- data_sources ----------
CREATE TABLE IF NOT EXISTS data_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name   TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('official','university','third_party','user_report','research_only')),
  source_url    TEXT,
  license_note  TEXT,
  retrieved_at  TIMESTAMPTZ,
  parser_version TEXT,
  data_version  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_name, data_version)
);
CREATE INDEX IF NOT EXISTS idx_data_sources_type ON data_sources (source_type);

-- ---------- schools ----------
CREATE TABLE IF NOT EXISTS schools (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_code TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  short_name  TEXT,
  school_type TEXT,
  location    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- departments ----------
CREATE TABLE IF NOT EXISTS departments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  department_code TEXT NOT NULL,
  name            TEXT NOT NULL,
  group_name      TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, department_code)
);
CREATE INDEX IF NOT EXISTS idx_departments_school ON departments (school_id);

-- ---------- admission_programs ----------
CREATE TABLE IF NOT EXISTS admission_programs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year         INTEGER NOT NULL CHECK (year BETWEEN 100 AND 200),
  program_type TEXT NOT NULL CHECK (program_type IN ('application','stars','distribution','tech_application')),
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, program_type)
);

-- ---------- department_admissions ----------
CREATE TABLE IF NOT EXISTS department_admissions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year                        INTEGER NOT NULL CHECK (year BETWEEN 100 AND 200),
  department_id               UUID NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
  program_id                  UUID NOT NULL REFERENCES admission_programs (id) ON DELETE RESTRICT,
  quota                       INTEGER NOT NULL CHECK (quota >= 0),
  chinese_requirement         TEXT,
  english_requirement         TEXT,
  math_a_requirement          TEXT,
  math_b_requirement          TEXT,
  social_requirement          TEXT,
  science_requirement         TEXT,
  english_listening_requirement TEXT,
  screening_ratio_1           NUMERIC,
  screening_ratio_2           NUMERIC,
  screening_ratio_3           NUMERIC,
  screening_score_1           TEXT,
  screening_score_2           TEXT,
  screening_score_3           TEXT,
  final_quota                 INTEGER CHECK (final_quota IS NULL OR final_quota >= 0),
  source_id                   UUID REFERENCES data_sources (id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, department_id, program_id)
);
CREATE INDEX IF NOT EXISTS idx_dept_adm_dept ON department_admissions (department_id);
CREATE INDEX IF NOT EXISTS idx_dept_adm_year ON department_admissions (year);
CREATE INDEX IF NOT EXISTS idx_dept_adm_program ON department_admissions (program_id);

-- ---------- historical_results ----------
CREATE TABLE IF NOT EXISTS historical_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year          INTEGER NOT NULL CHECK (year BETWEEN 100 AND 200),
  department_id UUID NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
  program_id    UUID NOT NULL REFERENCES admission_programs (id) ON DELETE RESTRICT,
  quota         INTEGER CHECK (quota IS NULL OR quota >= 0),
  applicants    INTEGER CHECK (applicants IS NULL OR applicants >= 0),
  screened      INTEGER CHECK (screened IS NULL OR screened >= 0),
  second_stage  INTEGER CHECK (second_stage IS NULL OR second_stage >= 0),
  admitted      INTEGER CHECK (admitted IS NULL OR admitted >= 0),
  waitlisted    INTEGER CHECK (waitlisted IS NULL OR waitlisted >= 0),
  minimum_score TEXT,
  average_score TEXT,
  source_id     UUID REFERENCES data_sources (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, department_id, program_id)
);
CREATE INDEX IF NOT EXISTS idx_hist_dept ON historical_results (department_id);
CREATE INDEX IF NOT EXISTS idx_hist_year ON historical_results (year);
CREATE INDEX IF NOT EXISTS idx_hist_program ON historical_results (program_id);

-- ---------- score_statistics (五標) ----------
CREATE TABLE IF NOT EXISTS score_statistics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year            INTEGER NOT NULL CHECK (year BETWEEN 100 AND 200),
  exam_type       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  top_standard    NUMERIC,
  high_standard   NUMERIC,
  average_standard NUMERIC,
  low_standard    NUMERIC,
  bottom_standard NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, exam_type, subject)
);
CREATE INDEX IF NOT EXISTS idx_score_stat_year ON score_statistics (year);
CREATE INDEX IF NOT EXISTS idx_score_stat_exam ON score_statistics (exam_type);
CREATE INDEX IF NOT EXISTS idx_score_stat_subject ON score_statistics (subject);

-- ---------- score_distributions ----------
CREATE TABLE IF NOT EXISTS score_distributions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year                  INTEGER NOT NULL CHECK (year BETWEEN 100 AND 200),
  exam_type             TEXT NOT NULL,
  subject               TEXT NOT NULL,
  score                 TEXT NOT NULL,
  candidate_count       INTEGER CHECK (candidate_count IS NULL OR candidate_count >= 0),
  percentage            NUMERIC,
  cumulative_percentage NUMERIC,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, exam_type, subject, score)
);
CREATE INDEX IF NOT EXISTS idx_score_dist_year ON score_distributions (year);
CREATE INDEX IF NOT EXISTS idx_score_dist_exam ON score_distributions (exam_type);
CREATE INDEX IF NOT EXISTS idx_score_dist_subject ON score_distributions (subject);

-- ---------- admission_preferences ----------
CREATE TABLE IF NOT EXISTS admission_preferences (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year              INTEGER NOT NULL CHECK (year BETWEEN 100 AND 200),
  department_id     UUID NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
  program_id        UUID NOT NULL REFERENCES admission_programs (id) ON DELETE RESTRICT,
  applications      INTEGER CHECK (applications IS NULL OR applications >= 0),
  first_choice_count  INTEGER CHECK (first_choice_count IS NULL OR first_choice_count >= 0),
  second_choice_count INTEGER CHECK (second_choice_count IS NULL OR second_choice_count >= 0),
  third_choice_count  INTEGER CHECK (third_choice_count IS NULL OR third_choice_count >= 0),
  source_id         UUID REFERENCES data_sources (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, department_id, program_id)
);

-- ---------- data_import_runs ----------
CREATE TABLE IF NOT EXISTS data_import_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         UUID REFERENCES data_sources (id) ON DELETE SET NULL,
  academic_year     INTEGER CHECK (academic_year IS NULL OR (academic_year BETWEEN 100 AND 200)),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','succeeded','failed','partial')),
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_inserted  INTEGER NOT NULL DEFAULT 0,
  records_updated   INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  parser_version    TEXT,
  data_version      TEXT
);

-- ---------- model_versions ----------
CREATE TABLE IF NOT EXISTS model_versions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  description          TEXT,
  training_data_version TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
