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
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TopNav />
        {children}
        <footer className="mt-8 border-t border-border">
          <div className="container flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-6 text-[13px] text-muted">
            <span>每日笑话 · v0.3.0 · 已审核演示内容，自动采集调度未启动</span>
            <span>
              吉祥物 blob 灵感来自{" "}
              <a
                href="https://github.com/jeremy-prt/bloub"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-4 hover:text-accent"
              >
                bloub
              </a>
              （MIT）
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
