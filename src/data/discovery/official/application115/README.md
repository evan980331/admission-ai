# P3.8 Discovery Manifest（domain layer，不下載）

```
P2.5 parsers → school/department indexes → P3.8 manifest → P3.9 acquisition → P3.7 detail → P3
```

- Parsing 只有一份實作（P2.5），此處 `parser.ts` 僅 re-export。
- `normalizer.ts`（buildManifest）：索引→canonical manifest＋provenance＋URL canonicalize。
- `validator.ts`：`new URL()` 嚴格驗證（host／scope／year／code），非 regex-only。
- `adapter.ts`：P2.5 輸出→manifest；manifest entry→P3.7 detail input。
- CLI 只讀本機檔；缺輸入即報錯，絕不上網。
