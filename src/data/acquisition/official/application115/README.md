# P3.9 Acquisition PoC（小批次，不做完整抓取）

```
P3.8 manifest → robots gate → serial GET → raw cache → P3.7 parse → report
```

- P2.5 基礎設施全重用（`client.ts` adapter re-export robots/Pacer/fetch；
  `fetchWithMeta` 為 P2.5 client 的 additive 擴充，`fetchText` 行為不變）。
- PoC batch 固定 4 個已驗證 URL（001012／001022／001032／001592），上限 10；
  `--code` 只能選 batch 內；任意 URL 不接受。
- robots fail-closed：`Disallow: /` → 全頁 `ROBOTS_BLOCKED`＋exit 3。
- Cache：`data/raw/.../detail/115_XXXXXX.htm`＋`.meta.json`（url／時間／狀態／sha256）；
  命中預設不重抓，`--refresh` 才重抓。raw 與 report 全 gitignored。
- Response 驗證：status／content-type／final host／scope／檔名-code 一致／
  detail 標記＋大小；200 不等於成功。
