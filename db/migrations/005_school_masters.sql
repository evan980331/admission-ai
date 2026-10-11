-- 005_school_masters
-- Official 115 school masters required by the admission acquisition queue.
-- schools is a cross-year master (no academic-year column): one row per
-- schoolCode. Names are verbatim from the official TotalGsdShow capture
-- (data/raw/official/115/application/universe/school-index.json) and the
-- official school PDFs. Idempotent (ON CONFLICT DO NOTHING): reruns never
-- duplicate, never overwrite curated names. Re-runnable (IF NOT EXISTS n/a
-- for DML, guarded by the conflict clause + migrate runner).
-- Does NOT touch 001/002/003/004 files.

INSERT INTO schools (school_code, name) VALUES
  ('001', '國立臺灣大學'),
  ('002', '國立臺灣師範大學'),
  ('003', '國立中興大學'),
  ('004', '國立成功大學'),
  ('005', '東吳大學'),
  ('006', '國立政治大學'),
  ('007', '高雄醫學大學'),
  ('008', '中原大學'),
  ('009', '東海大學'),
  ('011', '國立清華大學')
ON CONFLICT (school_code) DO NOTHING;
