-- 002_student_preferences
-- P1-A Student / Preference domain. Re-runnable (IF NOT EXISTS).
-- Principles: student-owned rows die with the profile (ON DELETE CASCADE,
-- unlike 001 school/department masters which are RESTRICT); Objective scores
-- and Preference rows live in separate tables and are never merged;
-- null = missing/unknown, never 0-filled; no passwords, no secrets,
-- no AI-generated probabilities, no unverified prediction results.
-- Does NOT touch 001_initial_schema.sql.

-- ---------- student_profiles ----------
CREATE TABLE IF NOT EXISTS student_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 100 AND 200),
  display_name  TEXT,
  school_name   TEXT,
  track         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_student_profiles_year ON student_profiles (academic_year);

-- ---------- student_exam_scores (objective: GSAT 0-15 per subject-year) ----------
CREATE TABLE IF NOT EXISTS student_exam_scores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 100 AND 200),
  subject       TEXT NOT NULL CHECK (subject IN ('chinese','english','math_a','math_b','social','science')),
  level         INTEGER CHECK (level IS NULL OR (level BETWEEN 0 AND 15)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, academic_year, subject)
);
CREATE INDEX IF NOT EXISTS idx_student_exam_scores_student ON student_exam_scores (student_id);

-- ---------- student_special_scores (objective: listening A/B/C/F, APCS 1-5) ----------
CREATE TABLE IF NOT EXISTS student_special_scores (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id          UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  academic_year       INTEGER NOT NULL CHECK (academic_year BETWEEN 100 AND 200),
  english_listening   TEXT CHECK (english_listening IS NULL OR english_listening IN ('A','B','C','F')),
  apcs_concept        INTEGER CHECK (apcs_concept IS NULL OR (apcs_concept BETWEEN 1 AND 5)),
  apcs_implementation INTEGER CHECK (apcs_implementation IS NULL OR (apcs_implementation BETWEEN 1 AND 5)),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, academic_year)
);
CREATE INDEX IF NOT EXISTS idx_student_special_scores_student ON student_special_scores (student_id);

-- ---------- student_region_preferences (preference; one row per region bans include+exclude conflict) ----------
CREATE TABLE IF NOT EXISTS student_region_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  region      TEXT NOT NULL CHECK (region IN ('北部','中部','南部','東部','離島')),
  direction   TEXT NOT NULL CHECK (direction IN ('included','excluded')),
  rank        INTEGER CHECK (rank IS NULL OR rank >= 1),
  weight      NUMERIC CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, region)
);
CREATE INDEX IF NOT EXISTS idx_student_region_prefs_student ON student_region_preferences (student_id);

-- ---------- student_interest_preferences (preference) ----------
CREATE TABLE IF NOT EXISTS student_interest_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  label       TEXT NOT NULL CHECK (label <> ''),
  rank        INTEGER CHECK (rank IS NULL OR rank >= 1),
  weight      NUMERIC CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, label)
);
CREATE INDEX IF NOT EXISTS idx_student_interest_prefs_student ON student_interest_preferences (student_id);

-- ---------- student_aptitude_preferences (preference) ----------
CREATE TABLE IF NOT EXISTS student_aptitude_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  dimension   TEXT NOT NULL CHECK (dimension IN ('語文','數理','空間','藝術','體能','社交','領導','實作')),
  rank        INTEGER CHECK (rank IS NULL OR rank >= 1),
  weight      NUMERIC CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, dimension)
);
CREATE INDEX IF NOT EXISTS idx_student_aptitude_prefs_student ON student_aptitude_preferences (student_id);

-- ---------- student_department_preferences (preference) ----------
CREATE TABLE IF NOT EXISTS student_department_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  school_code     TEXT NOT NULL CHECK (school_code ~ '^[0-9]{3}$'),
  department_code TEXT NOT NULL CHECK (department_code ~ '^[0-9]{6}$'),
  rank            INTEGER NOT NULL CHECK (rank >= 1),
  weight          NUMERIC CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, school_code, department_code)
);
CREATE INDEX IF NOT EXISTS idx_student_dept_prefs_student ON student_department_preferences (student_id);
CREATE INDEX IF NOT EXISTS idx_student_dept_prefs_dept ON student_department_preferences (school_code, department_code);

-- ---------- student_career_preferences (preference) ----------
CREATE TABLE IF NOT EXISTS student_career_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES student_profiles (id) ON DELETE CASCADE,
  label       TEXT NOT NULL CHECK (label <> ''),
  rank        INTEGER CHECK (rank IS NULL OR rank >= 1),
  weight      NUMERIC CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, label)
);
CREATE INDEX IF NOT EXISTS idx_student_career_prefs_student ON student_career_preferences (student_id);
