-- 004_admission_source_fields
-- P1-C.1 blocking fix: canonical fields with no DB home.
-- department_admissions gains per-department source_url (data_sources rows
-- are batch-level and cannot hold per-department URLs) plus first/second
-- stage overall weights. All nullable, additive only (no DROP/ALTER of
-- existing columns). Re-runnable (IF NOT EXISTS).
-- Does NOT touch 001/002/003 files.

ALTER TABLE department_admissions
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS first_stage_weight TEXT,
  ADD COLUMN IF NOT EXISTS second_stage_weight TEXT;
