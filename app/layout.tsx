import type { Metadata } from "next";
import "./globals.css";
import TopNav from "@/components/TopNav";

export const metadata: Metadata = {
  title: "每日笑话",
  description: "每天一期，短笑话与长篇佳作，轻量阅读。",
};

// 主题引导：优先读取本地保存值，否则跟随系统；在首帧前执行避免闪烁。
const themeBootstrap = `(function(){try{var s=localStorage.getItem("joke-theme");var d=s?s==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;if(d)document.documentElement.classList.add("dark");}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script>{themeBootstrap}</script>
      </head>
      <body>
        <TopNav />
        {children}
        <footer className="footer">
          <div className="container">
            每日笑话 · v0.1.0 · 已审核演示内容，自动采集调度未启动
          </div>
        </footer>
      </body>
    </html>
  );
}
