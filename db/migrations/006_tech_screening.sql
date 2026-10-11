-- 006_tech_screening
-- P4.1d 術科篩選 canonical tables. Re-runnable (IF NOT EXISTS).
-- Principles (mirrors 003): every child row hangs off department_admissions
-- (via the group); unstructured content is always kept in source_text;
-- null = missing, never 0-filled; no destructive changes to 001..005.
-- Scope: 13-cell arts-variant tech blocks only. 11-cell APCS-variant tech
-- columns duplicate the nested APCS table and are NOT modeled here
-- (covered by apcs_requirements). One group per admission at most
-- (UNIQUE admission_id); items hang off the group, never carry weights
-- (weights live on the group or on an attributed second_stage item —
-- never both, enforced by the loader + P4 gate, never split by guess).
-- Does NOT touch 001/002/003/004/005 files.

-- ---------- tech_screening_groups (術科區塊：共用佔比只記一次) ----------
CREATE TABLE IF NOT EXISTS tech_screening_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id    UUID NOT NULL UNIQUE REFERENCES department_admissions (id) ON DELETE CASCADE,
  weight          TEXT,
  weight_status   TEXT NOT NULL CHECK (weight_status IN ('shared','attributed_to_stage2','unstated')),
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tech_group_adm ON tech_screening_groups (admission_id);

-- ---------- tech_screening_items (術科篩選：一階篩選角色；無 weight 欄) ----------
CREATE TABLE IF NOT EXISTS tech_screening_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES tech_screening_groups (id) ON DELETE CASCADE,
  admission_id    UUID NOT NULL REFERENCES department_admissions (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position >= 1),
  name            TEXT NOT NULL,
  requirement     TEXT,
  multiplier      NUMERIC,
  score_method    TEXT,
  source_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tech_item_group ON tech_screening_items (group_id);
CREATE INDEX IF NOT EXISTS idx_tech_item_adm ON tech_screening_items (admission_id);
