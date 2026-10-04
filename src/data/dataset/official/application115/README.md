# P3.13 Dataset（本地累積，離線）

```
P3.11 local import → merge（identity＋sha 版本化）→ dataset.json
                                                → coverage.json
```

- Identity：`academicYear|schoolCode|departmentCode`；同 sha→unchanged，
  異 sha→舊版保留＋content_changed；絕不靜默覆寫／刪除。
- Provenance：sourceUrl／capturedAt／sha256／parserVersion／dataVersion
  全進 entry；無 meta 者狀態 source_unverified（可解析但不算已驗證）。
- parse/normalization 失敗：record 保留、狀態標記、canonical 不產生。
- 缺值 null／[]；merge deterministic（key 排序）；universe 缺席不發明。
