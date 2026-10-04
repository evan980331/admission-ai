# P3.12 Browser-Assisted Acquisition（讀使用者已開好的 Chrome，不爬 CAC）

```
使用者 Chrome（已開官方 detail 頁）
  → localhost CDP /json → 選唯一 CAC 115 tab
  → Runtime.evaluate outerHTML（完整 document）
  → URL＋內容驗證 → raw＋meta 儲存
  → P3.7 parse → P3 normalize（不寫 DB）
```

- 唯一允許的網路對象是 `127.0.0.1`（`assertLoopback`，它域即丟出錯；
  有測試鎖定）。不 fetch CAC、不遍歷、不開 tab。
- 同一時刻多個 CAC tab → 拒絕（請只留一頁）；零 CAC tab → 提示開頁。
- 檔名 `115_<code>.htm`；同 hash→already_captured；異動→舊檔版本化
  `115_<code>.<sha8>.htm` 後寫新檔，meta 記 previousSha256。
- meta 只有 outerHTML 衍生＋採集資訊：無 cookie／header／auth／profile。
