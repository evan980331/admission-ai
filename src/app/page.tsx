export default function Home() {
  return (
    <main style={{ padding: 32, maxWidth: 860, margin: "0 auto" }}>
      <h1>Predicter 資料平台（P1 基礎建設階段）</h1>
      <p>
        本階段目標：建立可長期使用的 GitHub + Neon + PostgreSQL + data pipeline
        基礎。本站目前<strong>不是</strong>落點查詢網站，不提供錄取機率。
      </p>
      <ul>
        <li>官方資料優先（大考中心 / 甄選會 / 分發會 / 各大學）</li>
        <li>所有資料保留 provenance（source / 年度 / parser / data version）</li>
        <li>歷史年度資料不覆寫， schema 支援全台校系擴充</li>
      </ul>
      <p>
        文件：
        <code>docs/research/P0-market.md</code>、
        <code>docs/research/P1-data-sources.md</code>、
        <code>docs/architecture/data-model.md</code>、
        <code>docs/data-sources/source-policy.md</code>
      </p>
    </main>
  );
}
