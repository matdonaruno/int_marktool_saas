import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Ad Autopilot SaaS",
  description: "Meta広告の競合リサーチ・クリエイティブ生成・自動入稿・8時間監視を自動化するSaaSプラットフォーム",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased bg-gray-50 text-gray-900">{children}</body>
    </html>
  );
}
