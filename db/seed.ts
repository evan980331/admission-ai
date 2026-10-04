import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

/**
 * Minimal TEST seed — research_only / test source.
 * 2~3 schools, 3~5 departments, years 111~115, gsat 五標, >=1 historical_results.
 * NEVER label test data as official.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");

    const source = await client.query(
      `INSERT INTO data_sources (source_name, source_type, source_url, license_note, retrieved_at, parser_version, data_version)
       VALUES ('p1-test-seed','research_only','https://example.invalid/p1-test-seed','TEST DATA ONLY — not official, do not use for predictions', now(), 'seed-v0.1.0','test-0.1.0')
       ON CONFLICT (source_name, data_version) DO UPDATE SET retrieved_at = now()
       RETURNING id`,
    );
    const sourceId: string = source.rows[0].id;

    const schools: Array<[string, string, string]> = [
      ["TEST-TPU", "測試臺北大學", "public"],
      ["TEST-NTU-DEV", "測試南方大學", "public"],
      ["TEST-PU", "測試私立大學", "private"],
    ];
    const schoolIds = new Map<string, string>();
    for (const [code, name, type] of schools) {
      const r = await client.query(
        `INSERT INTO schools (school_code, name, short_name, school_type, location)
         VALUES ($1,$2,$3,$4,'test')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id`,
        [code, name, name, type],
      );
      schoolIds.set(code, r.rows[0].id);
    }

    const departments: Array<[string, string, string]> = [
      ["TEST-TPU", "TEST-CS", "測試資訊工程學系"],
      ["TEST-TPU", "TEST-EE", "測試電機工程學系"],
      ["TEST-NTU-DEV", "TEST-BA", "測試企業管理學系"],
      ["TEST-NTU-DEV", "TEST-ECON", "測試經濟學系"],
      ["TEST-PU", "TEST-DESIGN", "測試設計學系"],
    ];
    const deptIds = new Map<string, string>();
    for (const [sCode, dCode, dName] of departments) {
      const r = await client.query(
        `INSERT INTO departments (school_id, department_code, name, group_name, is_active)
         VALUES ($1,$2,$3,'test-group', TRUE)
         ON CONFLICT (school_id, department_code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id`,
        [schoolIds.get(sCode), dCode, dName],
      );
      deptIds.set(`${sCode}:${dCode}`, r.rows[0].id);
    }

    const years = [111, 112, 113, 114, 115];
    for (const y of years) {
      await client.query(
        `INSERT INTO admission_programs (year, program_type, name, description)
         VALUES ($1,'application','大學個人申請','TEST program row — research_only')
         ON CONFLICT (year, program_type) DO NOTHING`,
        [y],
      );
    }

    // 五標測試資料 (gsat, 國文)：保持 top >= high >= avg >= low >= bottom
    const gsatSubjects = ["chinese", "english", "math_a", "math_b", "social", "science"];
    const five: Record<number, [number, number, number, number, number]> = {
      111: [13, 12, 10, 8, 6],
      112: [13, 12, 10, 8, 6],
      113: [13, 12, 10, 8, 6],
      114: [13, 12, 10, 8, 7],
      115: [13, 12, 10, 9, 7],
    };
    for (const y of years) {
      for (const s of gsatSubjects) {
        const [top, high, avg, low, bottom] = five[y]!;
        await client.query(
          `INSERT INTO score_statistics (year, exam_type, subject, top_standard, high_standard, average_standard, low_standard, bottom_standard)
           VALUES ($1,'gsat',$2,$3,$4,$5,$6,$7)
           ON CONFLICT (year, exam_type, subject) DO UPDATE SET
             top_standard=EXCLUDED.top_standard, high_standard=EXCLUDED.high_standard,
             average_standard=EXCLUDED.average_standard, low_standard=EXCLUDED.low_standard,
             bottom_standard=EXCLUDED.bottom_standard`,
          [y, s, top, high, avg, low, bottom],
        );
      }
    }

    // 至少一筆 admission + historical_results（以 TEST-TPU:TEST-CS / 114 為代表）
    const prog114 = (
      await client.query(
        `SELECT id FROM admission_programs WHERE year = 114 AND program_type = 'application'`,
      )
    ).rows[0].id as string;
    const csId = deptIds.get("TEST-TPU:TEST-CS")!;
    await client.query(
      `INSERT INTO department_admissions (year, department_id, program_id, quota, screening_ratio_1, source_id)
       VALUES (114,$1,$2,40,3,$3)
       ON CONFLICT (year, department_id, program_id) DO UPDATE SET quota=EXCLUDED.quota, source_id=EXCLUDED.source_id, updated_at=now()`,
      [csId, prog114, sourceId],
    );
    await client.query(
      `INSERT INTO historical_results (year, department_id, program_id, quota, applicants, screened, admitted, source_id)
       VALUES (114,$1,$2,40,320,120,40,$3)
       ON CONFLICT (year, department_id, program_id) DO UPDATE SET
         quota=EXCLUDED.quota, applicants=EXCLUDED.applicants, screened=EXCLUDED.screened,
         admitted=EXCLUDED.admitted, source_id=EXCLUDED.source_id`,
      [csId, prog114, sourceId],
    );

    await client.query(
      `INSERT INTO data_import_runs (source_id, academic_year, finished_at, status, records_processed, records_inserted, records_updated, error_count, parser_version, data_version)
       VALUES ($1, 114, now(), 'succeeded', 20, 20, 0, 0, 'seed-v0.1.0', 'test-0.1.0')`,
      [sourceId],
    );

    await client.query("COMMIT");
    console.log("seed done (research_only test data, source=p1-test-seed)");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
