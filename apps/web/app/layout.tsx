import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "卡牌市场模拟器",
  description: "本地优先的卡牌市场模拟器"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
