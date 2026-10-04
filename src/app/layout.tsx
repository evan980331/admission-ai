import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Predicter｜台灣大學升學落點預測／決策系統",
  description: "官方招生資料 → 歷史資料 → 統計模型 → 個人錄取機率 → 志願組合最佳化",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
