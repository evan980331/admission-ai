-- 003_admission_detail
-- P1-B Canonical Admission Detail tables. Re-runnable (IF NOT EXISTS).
-- Principles: every child row hangs off department_admissions (header stays
-- backward compatible for the P2 CSV path); over-quota and tie-break share
-- ONE ordered-rule table (kind discriminator — identical shape, single
-- ordering semantic); unstructured content is always kept in source_text;
-- null = missing, never 0-filled; no destructive changes to 001/002.
-- Does NOT touch 001_initial_schema.sql or 002_student_preferences.sql.
-- Companion domain: src/domain/admission/ (fromDetail -> toDbRecords).

-- ---------- screening_subject_rules (一階：科目檢定 x 倍率 x 採計) ----------
CREATE TABLE IF NOT EXISTS screening_subject_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position >= 1),
  subject         TEXT NOT NULL,
  requirement     TEXT,
  multiplier      NUMERIC,
  score_method    TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','not_applicable','unknown')),
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_screen_subj_adm ON screening_subject_rules (admission_id);

-- ---------- screening_sequences (超額篩選 + 同分參酌：同一有序規則形狀) ----------
CREATE TABLE IF NOT EXISTS screening_sequences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('over_quota','tie_break')),
  position        INTEGER NOT NULL CHECK (position >= 1),
  subjects        TEXT,
  description     TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, kind, position)
);
CREATE INDEX IF NOT EXISTS idx_screen_seq_adm ON screening_sequences (admission_id);

-- ---------- second_stage_items (二階：項目 x 檢定 x 佔比；weight 與 requirement 分欄) ----------
CREATE TABLE IF NOT EXISTS second_stage_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position >= 1),
  name            TEXT NOT NULL,
  requirement     TEXT,
  weight          TEXT,
  item_type       TEXT,
  description     TEXT,
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, position)
);
CREATE INDEX IF NOT EXISTS idx_stage2_adm ON second_stage_items (admission_id);

-- ---------- apcs_requirements (APCS 內嵌表；group note 逐列重複，已註記) ----------
CREATE TABLE IF NOT EXISTS apcs_requirements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position >= 1),
  subject         TEXT NOT NULL,
  requirement     TEXT,
  multiplier      NUMERIC,
  note            TEXT,
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, position)
);
CREATE INDEX IF NOT EXISTS idx_apcs_adm ON apcs_requirements (admission_id);

-- ---------- review_requirements (審查資料；結構化欄位待未來 parser 拆分，原文必留) ----------
CREATE TABLE IF NOT EXISTS review_requirements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position >= 1),
  category_code   TEXT,
  category_name   TEXT,
  required        TEXT,
  minimum_count   INTEGER CHECK (minimum_count IS NULL OR minimum_count >= 0),
  maximum_count   INTEGER CHECK (maximum_count IS NULL OR maximum_count >= 0),
  description     TEXT,
  restriction     TEXT,
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, position)
);
CREATE INDEX IF NOT EXISTS idx_review_adm ON review_requirements (admission_id);

-- ---------- special_requirements (特殊資格：kind/value 統一形狀，不塞 notes) ----------
CREATE TABLE IF NOT EXISTS special_requirements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('gender_restriction','offshore_restriction','indigenous_extra','offshore_extra','vision_extra','english_listening')),
  value           TEXT,
  source_text     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_special_adm ON special_requirements (admission_id);

-- ---------- admission_schedule (時程 DATE + 原文；甄試費併此表，見註) ----------
-- application_fee lives here (not its own table): a fee-only table would be
-- a single-column join for zero modeling gain.
CREATE TABLE IF NOT EXISTS admission_schedule (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id              UUID NOT NULL UNIQUE REFERENCES department_admissions (id) ON DELETE CASCADE,
  application_fee           INTEGER CHECK (application_fee IS NULL OR application_fee >= 0),
  application_fee_source    TEXT,
  notification_date         DATE,
  notification_source       TEXT,
  material_deadline         DATE,
  material_deadline_source  TEXT,
  second_stage_date         DATE,
  second_stage_date_source  TEXT,
  result_date               DATE,
  result_date_source        TEXT,
  recheck_deadline          DATE,
  recheck_deadline_source   TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedule_adm ON admission_schedule (admission_id);

-- ---------- admission_notices (官方備註：逐條保序，未知分類=other，不刪除) ----------
CREATE TABLE IF NOT EXISTS admission_notices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position >= 1),
  type            TEXT NOT NULL DEFAULT 'other',
  text            TEXT NOT NULL,
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admission_id, position)
);
CREATE INDEX IF NOT EXISTS idx_notices_adm ON admission_notices (admission_id);
