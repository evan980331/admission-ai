# 資料來源政策（source-policy）

## PRIMARY（官方優先）
- 大考中心 — https://www.ceec.edu.tw/
- 大學甄選入學委員會相關官方資料 — https://www.cac.edu.tw/
- 大學考試入學分發委員會 — https://www.uac.edu.tw/

## SECONDARY
- 各大學官方招生資料（簡章、分則、公告名額與結果）。

## RESEARCH ONLY
- https://www.com.tw/
- 允許：競品功能研究、資料結構研究、呈現方式研究、交叉驗證方向研究。
- 禁止：在確認授權前，直接複製或重新發布其資料進商業資料庫。
- Seed／測試資料一律標 `source_type = research_only`，不得偽裝成官方資料。

## Provenance 要求
每筆重要資料保留：`source`、`source_url`、`academic_year`、`retrieved_at`、`parser_version`、`data_version`（對應 `data_sources` + `data_import_runs`）。
