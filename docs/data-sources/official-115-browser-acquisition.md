# Official Browser Acquisition（P3.12）

## 1. 為什麼不用 CAC HTTP crawler

cac.edu.tw robots 全站 `Disallow: /`，且本機直連失敗；
P2.5 crawler 維持 fail-closed。本工具**不向 CAC 建立任何 HTTP 連線**，
只讀取使用者自己用 Chrome 開好的頁面（localhost CDP）。

## 2. Robots 限制

工具本身不抓 CAC，但「讀已開頁面是否合規」取決於 CAC 使用條款；
文件只描述技術行為：**請使用者自行確認網站條款／政策**，不宣稱合規。

## 3. 概念

使用者開頁 → 工具經 `http://127.0.0.1:9222/json` 找唯一 CAC 115 tab →
`Runtime.evaluate(document.documentElement.outerHTML)` → 驗證 → 存檔 →
P3.7 → P3。一次只處理目前 tab，不遍歷、不開分頁。

## 4. Chrome 啟動（Windows PowerShell）

先完全關閉 Chrome，再：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\predicter-chrome"
```

Chrome 路徑依安裝位置調整（也有 `...\Chrome Beta\...`、
`$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe` 等變體）；
工具**不幫你啟動 Chrome**，`/json` 連不上即 exit 2 並提示。

## 5–7. CLI 與操作

```bash
npm run data:import-official-browser            # 讀目前 tab
npm run data:import-official-browser -- --port 9222 --dry-run
```

全域一次只允許一個 CAC 115 tab（多個即拒絕，請只留一頁）；
跑完顯示 tab／校系／URL／大小／SHA／capture-parser-normalization 狀態；
**絕不自動前往下一頁**（下一頁機制另行設計）。

## 8–10. Raw／metadata／duplicate

`data/raw/official/115/application/departments/115_<code>.htm`（gitignored）；
同 hash→`already_captured`（不碰檔案）；異動→舊檔版控為
`115_<code>.<sha8>.htm` 後寫新檔，meta 記 previousSha256。
meta 只有 outerHTML 衍生＋採集資訊：**無 cookie／header／auth／profile**。

## 11–13. 管線／安全

capture→P3.7 parse→P3 normalize（重用，不寫 DB；parse 失敗 raw 照留，
狀態 `parse_error`）。網路邊界：只許 `127.0.0.1`（`assertLoopback`＋測試鎖定；
無 puppeteer／playwright／axios／curl，CDP 用 Node 內建 WebSocket）。
