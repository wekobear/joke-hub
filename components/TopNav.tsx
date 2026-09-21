"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@heroui/react";

export default function TopNav() {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("joke-theme", next ? "dark" : "light");
    } catch {}
  }

  const links = [
    { href: "/", label: "今日笑话" },
    { href: "/library", label: "笑话库" },
    { href: "/skill", label: "使用教程" },
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="container flex h-16 items-center gap-7">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-wide">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo.png"
            alt="每日笑话 logo"
            width={36}
            height={36}
            className="size-9 rounded-xl object-cover"
          />
          每日笑话
        </Link>
        <nav
          aria-label="主导航"
          className="flex flex-1 gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]"
        >
          {links.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={
                  "rounded-lg px-2.5 py-2.5 text-[15px] transition-colors " +
                  (active
                    ? "font-medium text-accent"
                    : "text-muted hover:text-foreground")
                }
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <Button
          isIconOnly
          variant="tertiary"
          aria-label="切换主题"
          onPress={toggleTheme}
        >
          {dark ? "☀️" : "🌙"}
        </Button>
      </div>
    </header>
  );
}
