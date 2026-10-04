# P1 Architecture Reset — 高中生升學決策與申請輔助系統

> 性質：架構審計＋重整設計（audit-only 產出）。本輪不改 source code／migration／tests，
> 不新增 dependency，不抓取任何網路資料。唯一新增檔案即本報告。
> 現況基準：tests 204/204；真實官方 capture 僅 `115_001012`、`115_001022`
>（皆 desktop layout-B）；`data/raw` gitignored；working tree 以審計時為準。

## 1. Product vision

Predicter 從「落點查詢」重整為「高中生升學決策與申請輔助系統」，八大能力：

1. 落點分析（objective／能不能上）
2. 個人申請一階分析（檢定×倍率×超額）
3. 個人申請二階分析（指定項目×權重×準備度）
4. 學習歷程／申請資料管理（evidence）
5. AI 文章審查與修改（evidence → feedback，不產機率）
6. 面試／筆試準備（模擬＋準備建議）
7. 志願組合最佳化（predictions＋preferences，受限最佳化）
8. AI 升學解釋與建議（解釋模型輸出，不創造機率）

鐵律（沿用 AGENTS.md 並擴充）：**Objective／Preference／Evidence 三者永不壓成一個總分；
preference 不得改變 admission probability；AI 不得產生機率，機率只來自 prediction engine；
P1 不做 LLM 實作、不做錄取機率宣稱**（AGENTS.md 紅線 #4 仍然有效，AI／機率實作閘門見 §11）。

## 2. Domain model

### 2.1 現有 domain（審計現況，`src/` 86 檔）

| Domain | 位置 | 成熟度 |
|---|---|---|
| Official acquisition | `src/data/acquisition/{official,browser}/`、P2.5 `src/data/crawlers/` | 高（robots fail-closed、CDP 單頁、identity 已修） |
| Detail parsing | `src/data/importers/official/application115/detail/`（layout-A/B、validator、normalizer） | 高（2 真實 capture 全綠） |
| Discovery／manifest | `src/data/discovery/`（P3.8 URL 政策＋canonical） | 中（無真實 universe manifest） |
| Local import | `src/data/importers/official/application115/local/`（P3.9 sidecar＋source gate） | 高（P3.14 對齊完成） |
| Dataset | `src/data/dataset/`（merge、carried/missing、coverage） | 高（JSON 檔級；尚未入 DB） |
| Normalization | `src/data/normalization/`（canonical record、null≠0、identity 消解） | 高 |
| Cross-validation | `src/data/validation/source-cross-validation/`、`third-party/university-tw`（結構限定） | 中 |
| Audit／coverage | `src/data/audit/` | 中 |
| Prediction | `src/server/prediction/`（types＋placeholder，全 null＋warnings） | 骨架（by design，不可宣稱機率） |
| UI | `src/app/`（layout＋page 殼） | 空殼 |
| **Student／Preference／Portfolio／Application／AI** | — | **不存在** |

### 2.2 新 domain（目標）

- **Student**：`student_profiles`（academic_year、school、track）、`student_scores`
 （gsat 6 科級分＋英聽級別＋APCS 觀念／實作級別，objective，逐年保存）、英聽/APCS 與學年綁定。
- **Preferences**：`student_preferences`（preferred/excluded_regions、interests、aptitudes、
  department/career 偏好＋權重）。純 preference，見 §2.4 隔離規則。
- **Admission**：學校／系所／program（既有）＋ 一階完整規則（§4 新子表）＋
  二階完整規則（項目×檢定×佔比）＋ 審查資料要求＋ 特殊資格＋ 日期／費用／備註（皆官方原文＋結構化並存）。
- **Historical**：既有四表（results／statistics／distributions／preferences 行為熱度）。
- **Portfolio**：`portfolio_items`（修課／成果／多元表現／自述，對應審查代碼 A–Q、R、S 等）、
  `portfolio_evidences`（檔案／連結／證明，hash＋時間戳）、與系所審查要求的覆蓋對應（屬 matching 結果，不存總分）。
- **Application**：`application_plans`（年度×學生）、`plan_items`（校系×狀態：考慮／已選／一階通過／二階準備中／錄取／備取／未上）、`second_stage_tasks`（筆試／口試／審查繳交通知與截止）。
- **AI**：`essays`（自傳／讀書計畫原文）、`essay_versions`（每次修改全量版）、
  `essay_reviews`（對照校系審查要求＋evidence 的逐條意見）、`interview_sessions`
 （題目×回答×回饋）、`ai_runs`（模型 id＋輸入 hash＋輸出引用，不存機率）。

### 2.3 資料流總覽（§5 展開）

官方：CAC → raw → parser → normalized → dataset → admission engine（DB 化後）。
學生：Profile → eligibility → score calc → prediction（objective only）。
二階：Portfolio ＋ Requirements → matching → gap → preparation（readiness，非機率）。
AI：Essay ＋ Requirements ＋ Evidence → review → feedback → revision（解釋／建議 only）。

### 2.4 三類資料隔離（Objective／Preference／Evidence）

| 類 | 內容 | 用於 | 儲存 |
|---|---|---|---|
| Objective | 學測 6 科、英聽、APCS、校系篩選條件、歷史結果／五標／分布 | 能不能上（eligibility＋prediction 唯一輸入） | `student_scores`、`screening_*`、`historical_*`、`score_*` |
| Preference | 地區（納／排）、興趣、性向、科系／生涯偏好 | 適不適合（排序／篩選／志願最佳化的目標函數） | `student_preferences`（獨立表，含權重，不進任何特徵向量） |
| Evidence | 學習歷程、專題、競賽、作品、自傳、讀書計畫 | 二階競爭力（matching 覆蓋率／gap，非分數） | `portfolio_*`、`essays`（原文＋版本鏈） |

隔離規則（寫進未來 validator，不只寫文件）：
R1. prediction engine 的特徵輸入型別不得包含 preference 欄位（type-level 隔離）。
R2. preference 只出現在 ranking／optimizer 的目標／約束層，且輸出必須同時呈現
「錄取面向排序」與「偏好面向排序」，禁止單一總分。
R3. evidence 只產生「要求覆蓋率／缺口清單」（matching），禁止轉成分數餵給機率模型。
R4. 任何跨類組合必須以顯式、可解釋的規則呈現（如志願的 Pareto 前緣），並標註不確定性。

## 3. Database evolution

現有 11 表（`db/migrations/001_initial_schema.sql`，唯一 migration；`db/seed.ts` 僅 `research_only`）。

| Table |  verdict | 原因 |
|---|---|---|
| `data_sources` | KEEP（小 MODIFY：加 `acquisition_method` nullable，收斂 browser_cdp／manual／http 以對齊 CaptureMeta） | provenance 登記簿已符合紅線；只缺採集方式欄 |
| `schools` | KEEP | 年無關主檔，職責正確 |
| `departments` | KEEP | 校系分離正確；地區等偏好屬性不得塞入（屬 preference 側） |
| `admission_programs` | KEEP | 年×管道鍵正確，不寫死 exam 邏輯 |
| `department_admissions` | MODIFY＋SPLIT（核心） | 見 §3.1：現行扁平欄裝不下一／二階完整規則 |
| `historical_results` | KEEP | 歷史事實表職責正確（counts 可 null，min/avg TEXT） |
| `score_statistics` | KEEP | 五標職責正確 |
| `score_distributions` | KEEP | 分布職責正確 |
| `admission_preferences` | KEEP（語義澄清） | 志願熱度是 objective 行為數據，供 heat 特徵用；不得與 `student_preferences` 混淆，建議改名或加註解為 `volunteer_heat` 概念 |
| `data_import_runs` | KEEP | 審計鏈正確 |
| `model_versions` | MODIFY（未來） | 需加 engine 名、輸入 schema hash、訓練窗、評估指標欄，否則無法支撐 §8 六引擎版本治理；P1 先不動 |

### 3.1 為何 `department_admissions` 必須 SPLIT（證據）

`detail/normalizer.ts` 已白紙黑字承認 lossy bridge：`toP2Row` 把
`screening_ratio_1/2/3`、`screening_score_1/2/3` 全部填 null（detail 頁只有 per-subject
倍率，沒有 1-2-3 序列），且** multipliers／scoreMethods／overQuota／tieBreak／
stage2 items×weights／review／interview／notes／APCS／extraQuotas／dates／fees
全部留在 detail JSON 裡，進不了 DB**；`toP3Input` 只帶 quota。
結論：DB 目前能回答「名額＋各科檢定門檻」，**不能回答**一階完整規則（檢定×倍率×採計、
英聽級別、APCS、超額序列）、二階完整規則（項目×檢定×佔比）、指定項目內容、特殊資格、
官方備註，更遑論 Student／Preference／Portfolio／Essay／AI（全無表）。
SPLIT 子表（`department_admission_id` FK，position 保序，原文＋結構化並存）：
`screening_subject_rules`（subject／requirement／multiplier／score_method）、
`screening_sequences`（kind=over_quota｜tie_break／position／rule_text）、
`second_stage_items`（name／requirement／weight）、`review_requirements`
（審查代碼 A–S／items／notes）、`admission_schedule`（notification／material／
exam／result／recheck 日期＋fee＋offshore_restriction）、`admission_notices`
（備註原文×條列＋contacts＋urls）。`screening_ratio_1/2/3` 舊欄保留給 P2 CSV 路徑，
文件標記為被 detail 路徑取代（不刪，避免破壞既有語義）。

### 3.2 新增表（設計，不實作）

`students`、`student_scores`（objective，UNIQUE student×year×subject）、
`student_preferences`（preference，含權重與排除）、`portfolio_items`、
`portfolio_evidences`（hash＋時間戳）、`application_plans`、`plan_items`
（狀態機）、`second_stage_tasks`、`essays`、`essay_versions`（全量版鏈）、
`essay_reviews`、`interview_sessions`、`ai_runs`（模型 id＋輸入 hash＋引用，
禁存機率）。所有學生／AI 表沿用 `data_sources`-式 provenance（來源 user_provided、
時間戳、版本）。

## 4. Data architecture

官方鏈（已驗證段）：CDP／manual → `data/raw`（gitignored，htm＋meta: sourceUrl／
academicYear／dept／school=dept[:3]／sha／capturedAt／parserVersion）→ P3.7 parser
（DetailRecord，rawFields＋unmapped 誠實缺口）→ P3.11 local import（P3.9 sidecar＋
P3.8 URL 政策＋code 一致，P3.14 對齊）→ P3.13 dataset（identity `115|001|001022`、
carried/missing、coverage）→ **缺：dataset→Postgres loader**（現況斷點：DB 只有 seed
資料；`normalize-historical` 可讀 DB 但無寫入 canonical 的 loader）。
學生鏈（新建）：Profile 入力（型別隔離 objective／preference）→ eligibility
（硬門檻：檢定／英聽／APCS／性別／特殊資格，pass／fail＋理由）→ score calc
（級分向量＋年度難度參照，不跨年直接比 raw）→ prediction engines（§8）。
Provenance（最成熟段，原樣沿用＋擴張）：五元組 source／source_url／academic_year／
retrieved_at／parser_version／data_version；學生資料記 user_provided＋時間戳；
AI 產出記模型 id＋輸入 hash＋引用引擎版本，禁存機率。

## 5. Student architecture

輸入正式定義（第一版，§6 落點輸入）：objective＝學測 6 科級分（國／英／數A／數B／
社／自，0–15 未考=未提供≠0）＋英聽（A–F／缺考）＋APCS（觀念／實作 1–5／未考）；
preference＝地區（納／排清單）、興趣、性向（量表＋自由標籤，皆權重化）。
流程：profile 建檔 → eligibility（對每校系硬規則逐條 verdict）→ 可投清單 →
prediction（§8）→ preference ranking（獨立排序）→ 雙排序並陳。**preference 欄位
在型別上進不了 prediction input**（R1），UI 層亦分開呈現「錄取面向」與「偏好面向」。

## 6. Admission architecture

Admission engine 讀 DB 化後的完整規則（§3.1 子表；未遷移前讀 dataset JSON，
唯讀轉接層，語義不變）。職責：(a) eligibility 判定（檢定／倍率門檻／英聽／APCS／
性別／特殊資格／離島限制）；(b) 一階篩選模擬（倍率×預計甄試人數×超額序列，
輸出通過帶＋邊界警示）；(c) 二階需求展開（項目×佔比×審查代碼×日期／費用／備註）。
規則一律保留官方原文（notice/review 層）＋結構化並存；缺失即 null＋warning，
沿用 P3.7 誠實傳統。

## 7. Portfolio architecture

`portfolio_items` 以校系審查代碼為外鍵詞彙（A 修課／B–E 課程成果／F–N 多元表現／
O–Q 自述／R、S 其他），每件掛 `portfolio_evidences`（檔案 hash、取得時間、頒發方）。
Matching＝系所 `review_requirements` × 學生 items 的覆蓋矩陣 → 輸出「已覆蓋／缺口／
薄弱（有件無證）」三態＋準備任務（寫入 `second_stage_tasks`），**不輸出分數**（R3）。
Essay（自傳／讀書計畫）是 portfolio 的一種，全版本鏈保存以供 AI review 差分。

## 8. Prediction architecture（只設計 interface，不實作；禁 accuracy 宣稱）

| Engine | Input | Output | Dependency | Uncertainty | Evaluation（協議，非數字） |
|---|---|---|---|---|---|
| `EligibilityEngine` | student objective＋校系硬規則 | pass／fail×理由（確定性） | admission engine | 無（規則判定；規則缺失→unknown＋warning） | 規則覆蓋率／unknown 率 |
| `FirstStagePrediction` | 級分向量＋倍率／超額＋歷史 band＋當年 heat | 通過帶（高／中／邊界／低）＋關鍵科目敏感度 | eligibility=pass、statistics、heat | band 而非點機率；附樣本數與年度可比性警示 | 回測：band 校準曲線（實作後） |
| `SecondStagePrediction` | evidence 覆蓋率＋二階佔比 | 準備度（充足／缺口 N 項／高風險缺口）**非機率** | matching、schedule | 質性；評審主觀不可建模→明示 | 缺口閉合率（追蹤，非準確率） |
| `FinalAdmissionPrediction` | 一階帶＋二階準備度 | 綜合帶＋不確定性聲明（區間＋理由） | 前兩者 | 顯式區間；拒絕單點機率 | 區間覆蓋率（實作後） |
| `PreferenceRanking` | preferences＋候選清單 | 偏好排序（與錄取排序分開呈現） | 無（禁讀 objective 以外） | 權重敏感度分析 | 與用戶最終選擇的一致性（描述性） |
| `VolunteerOptimizer` | 綜合帶＋偏好＋名額約束 | Pareto 組合建議（衝／穩／保分層，附取捨說明） | 全部上游＋版本鎖定 | 情境分析（heat 變動） | 分層覆蓋（事後描述，非宣稱） |

版本治理沿用 `model_versions`（§3 MODIFY 後）：engine 名＋輸入 schema hash＋訓練窗＋
指標快照；任何輸出攜 `modelVersion＋dataVersion＋warnings`（沿用 placeholder 傳統）。

## 9. AI architecture（設計；實作閘門 P2 之後，紅線 #4）

AI 只能做七件事：解釋模型輸出、分析文章、分析學習歷程、比對校系要求、提修改建議、
模擬面試、產生準備建議。硬邊界：AI 函數簽名**無機率回傳型別**（type-level）；
essay review 輸入＝（essay 版本＋`review_requirements`＋引用 evidence hashes），
輸出＝逐條意見（引用＋嚴重度＋改寫方向），寫回 `essay_versions` 新版；
interview sim 輸入＝（系所考古方向＋學生 evidence），輸出＝題目×評分 rubric×回饋，
禁存「錄取率」；所有 AI 產出存 `ai_runs`（模型 id＋輸入 hash＋人工覆寫旗），
可審計、可重現、可關閉（kill-switch）。

## 10. Data ingestion roadmap

### 10.1 現況（誠實盤點）

有：115 detail 真實 capture ×2 系（desktop layout-B，parser 全綠）；mobile fixtures ×4；
URL 政策／sidecar／dataset／coverage 工具鏈；seed `research_only` 五標（假資料，
禁當正式）。缺：universe manifest（真實）、115 全系 detail、111–114 一切歷史、
`admission_preferences` 行為熱度、DB loader（§4 斷點）。

### 10.2 Current year（115 個人申請）

school universe → department universe → detail pages（一階／二階／審查／特殊資格／
日期／備註），全部走既有鏈（user 自開 CDP 單頁採集 或 manual＋local import；
manifest 由已驗證 URL 長出，不倒果為因）。順序：先遷移 §3.1 子表並回填 2 已採系
→ loader 入 DB → 再擴系（一次一頁，用戶節奏，禁並行轟炸）。

### 10.3 Historical（111–115）

策略：官方來源優先（簡章／統計 PDF→人工結構化，`research_only` 標記過渡資料絕不混入）；
UTW 僅結構／交叉驗證（沿用 P3.6，不複製進商業 DB）；browser/CDP 只處理當年 detail，
歷史不適用；111–115 年度可比性沿用 `normalize-year`（參照調整，非直接比 raw）。
缺口：111–114 官方歷史來源尚未 xác認 → 列為待確認決策 D5。

### 10.4 Robots

cac.edu.tw 全站 `Disallow: /` → fail-closed 維持：禁 crawler 繞過、禁並行、禁猜 URL；
只允許 (a) 用戶自己開啟頁面的 CDP 讀取、(b) 人工下載＋local import。
任何「加速」提案若觸碰此線，直接否決（寫進 CONTRIBUTING 級別規則，待建）。

## 11. Phase roadmap

- **P1-A（架構＋學生域）**：本報告定稿 → `students`／`student_scores`／
  `student_preferences` migration（002）＋ eligibility 純函數＋ tests（禁機率字眼）。
- **P1-B（admission DB 化）**：§3.1 SPLIT migration（003）＋ dataset→DB loader ＋
  回填 001012／001022（驗收：DB 查詢可重現 parser 全欄）。
- **P1-C（engines 接口）**：§8 六接口＋全 null／band 骨架＋版本治理（`model_versions`
  MODIFY migration 004），仍不輸出可宣稱機率。
- **P1-D（採集擴大）**：115 universe（用户節奏 CDP）＋ 111–115 歷史缺口關閉；
  驗收：coverage 達標且零 `source_unverified` 漏網。
- **P2（AI 層，紅線 #4 之後）**：§9 實作（essay review→interview sim），type-level 禁機率。
- **P3（機率與最佳化，協議先行）**：band 校準回測 → FinalAdmission＋Optimizer 上線，
  輸出永遠帶區間＋warnings。
- 每階段出口：`test＋typecheck＋lint＋build＋validate` 全綠才可 commit（沿用工程準則）。

## 12. Risks

R-robots：任何自動化觸碰 CAC 即違規 → 緩解：CDP 單頁＋人工節奏＋自動化測試鎖零網路。
R-probability：過早機率宣稱毀信任 → 緩解：placeholder 傳統延續，band＋區間＋warnings，
評估協議先於數字。R-history：111–114 無官方源 → 緩解：缺口明示＋`research_only`
隔離，絕不拿 UTW 充數。R-scope：八大能力一次全做 → 緩解：§11 分期，P1 只做架構＋
資料＋接口。R-schema-drift：detail JSON 與 DB 雙寫分歧 → 緩解：loader 單向＋回填驗收
（DB 可重現 parser 全欄）。R-AI-leak：AI 間接產機率 → 緩解：簽名禁機率＋ai_runs 審計。

## 13. Decisions requiring confirmation

## 14. P1-A 完成紀錄（已實作）

- Domain：`src/domain/student/`（`types.ts`、`validation.ts`、`index.ts`，pure TS，
  無 DB／無網路依賴）。`StudentProfile` 只放 id／academicYear／displayName／
  schoolName／track＋時間戳；成績與偏好分離在各自型別。
- Objective：`GsatScores`（6 科 0–15／null，null≠0）、`ListeningGrade`（A/B/C/F／null）、
  `ApcsScores`（觀念／實作 1–5／null）；`validateSameYear` 禁跨年直接比較；
  不做 percentile／z-score 推算。
- Preference：regions（北部／中部／南部／東部／離島，included／excluded，DB 以
  `UNIQUE(student_id, region)` 在庫層禁止又納又排）、interests（開放 label）、
  aptitudes（8 維閉集）、departmentPreferences（school 3 碼＋dept 6 碼＋rank 必填且
  不得重 rank＋weight 0–1）、careerInterests。rank≥1、weight 0–1、重複／衝突皆 error。
- Type 隔離：`AdmissionPredictionInput`（branded objective-only，
  `toAdmissionPredictionInput` 無 preference 參數槽）vs `PreferenceRankingInput`
 （branded，雙向不可 assign，`expectTypeOf` 鎖定）；`VolunteerContext` 並置不合併。
- Migration：`db/migrations/002_student_preferences.sql`（8 表，IF NOT EXISTS，
  001 未動）。學生表 FK `ON DELETE CASCADE`（owned 資料隨 profile 消失，與 001
  masters 的 RESTRICT 語義不同，已在檔頭註記）；禁密碼／secret／機率欄。
- Tests：`tests/student-domain.test.ts` 19 測（academic／preference／boundary／
  migration 靜態檢查，後者不斷言 live DB）。
- 未做（留後續 phase）：UI、auth、LLM、essay、portfolio、interview、
  prediction model、probability、推薦演算法、CAC 相關一切、dataset→DB loader。
  P3 acquisition／parser 行為零變更。

D1. `department_admissions` 採 SPLIT 子表（本報告建議）vs 另建平行 `detail_*` 表？
D2. `screening_ratio_1/2/3` 舊欄保留（P2 CSV 相容）或標 DEPRECATE？
D3. 機率表示法：band＋區間（建議）vs 點機率（禁？需拍板，牽涉紅線 #4 修訂時機）。
D4. AI 實作閘門：維持 P1 禁 LLM（建議，紅線 #4 不動）或提前？
D5. 111–114 歷史官方來源策略（合作／人工結構化／暫缺並明示）。
D6. universe manifest 取得方式（用户 CDP 節奏 vs 人工清單，皆禁爬蟲）。
D7. 學生個資存放：地端優先 vs Neon（牽涉隱私與 `research_only` 隔離）。
D8. 志願最佳化目標函數定義權（錄取帶×偏好權重公式需產品拍板，R2 框架下）。
