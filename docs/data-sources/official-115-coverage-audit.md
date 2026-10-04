# Official 115 Coverage Audit（P3.10）

> 本 Audit 不進行網路請求，也不嘗試繞過 CAC robots。
> 數字來自本機掃描（fixtures＋processed reports＋raw 清單），非硬編碼；
> 完整 machine-readable 輸出見 `data/processed/official/115/application/coverage/`
>（gitignored）。PDF 系級內容因無正式 PDF importer 而標 unknown，不假裝已解析。

## 1. 現有來源

| 來源 | 狀態 |
|---|---|
| CAC detail HTML（P3.7 fixtures，4 頁已驗證） | parser 成功 4/4 |
| 官方 PDF（使用者提供 4 份：總覽＋001／002／003） | 存在；系級內容未進機器報告 |
| University TW（P3.6 實測 3 校） | subset：167 match／12 missing／0 extra |
| P3.7 parser／P3.8 manifest／P3.9 PoC | capability 就緒，acquisition 被 robots 擋下 |

## 2. Source tier

official（CAC HTML／PDF／各大學）唯一 authoritative；
third_party（UTW）只驗證／探索；research_only（com.tw／seed／fixture）不進正式層。
第三方永不覆蓋官方。

## 3. CAC robots 現況

全站 `Disallow: /`（P2 驗證、P2.5／P3.9 持續執行 fail-closed）；
UTW robots 僅禁 `/search`、`/go-to/`。本機直連 CAC 亦失敗，雙重確定禁批量。

## 4–6. Parser／manifest／acquisition 能力

- P3.7：4 fixtures 全解析、0 error；特殊版式（英聽列／APCS 表／rowspan）已處理。
- P3.8：manifest schema＋嚴格 URL 驗證就緒；真實 manifest 待合規取得索引後產生。
- P3.9：PoC 4 URL 干跑零請求；live 觸發 ROBOTS_BLOCKED＋exit 3（政策性停止）。

## 7. PDF coverage

4 份存在（P3.5 已驗：001→73、002→58、003→51 系碼，與總覽吻合；全文字型免 OCR）。
機器報告只記 presence；系級欄位 coverage＝unknown（誠實：無 PDF importer）。

## 8. University TW coverage

官方 182 系中 UTW 覆蓋 170（93%）；缺 12 全屬 UTW 自述排除範圍
（術科 5、APCS 4、資安 2、性別限制 1）；重疊系 quota 零差異、名稱全 match
（含⺠字根相容字處理）。**UTW 是 subset，不是完整集**，缺失不是 parser bug。

## 9–10. Field／department coverage（機器報告實測）

- manifest 182 系：officialHtml 4、thirdParty 170、parsed 4、normalized（115）0。
- 4 個已解析系：19 個欄位群組幾乎全 known（APCS 僅適用 1 系；practical 無適用）。
- 未取得系：全部欄位 SOURCE_GAP（頁面存在但未合規取得），共 3382 項。

## 11. Data gaps

- ACQUISITION_GAP：178 系全部欄位（主缺口；需合規取得，見 §12）。
- PARSER_GAP：0（現有 parser 覆蓋已見版式）。
- SOURCE_GAP：同上 3382（manifest URL 尚未官方發現）。
- NOT_APPLICABLE：9（APCS／術科／相加語文等系所差異）。
- UNKNOWN：0。

## 12. 下一步建議

1. **最高優先：人工下載 TotalGsdShow＋64 校 ShowSchGsd**（瀏覽器另存，合法），
   跑 `data:build-official-manifest` 產生真實 manifest（去 178 系的 SOURCE_GAP 之名）。
2. **次之：人工下載 2206 明細頁或分批**（或等 robots 政策變化；絕不繞過），
   跑 P3.9 acquisition（cache＋report 已就緒）→ P3.7 parse → P3 normalize。
3. **PDF extractor 正式化**（P3.5 架構：PDF→中繼 JSON→現有 importer），
   先做 001 三校 golden-master；系碼數 73／58／51 可做第一道驗證。
4. **UTW 作為交叉驗證常態工具**：每次官方批次後跑 `data:cross-validate`，
   監控 missing／mismatch（特別是 APCS／術科等預期缺失之外的差異）。
5. **商用前確認 UTW 使用條件**（站上無授權條款，僅「僅供參考」聲明）。
6. P4 特徵工程只能吃 parsed＋comparable 資料；normalized（115）目前為 0，
   不可拿 fixture 當訓練資料。
