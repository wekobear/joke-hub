"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

function SmileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.6" />
      <circle cx="8.6" cy="10" r="1.2" fill="var(--accent)" />
      <circle cx="15.4" cy="10" r="1.2" fill="var(--accent)" />
      <path
        d="M7.8 14c1 1.6 2.5 2.5 4.2 2.5s3.2-.9 4.2-2.5"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

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
    <header className="topnav">
      <div className="container topnav-inner">
        <Link href="/" className="brand">
          <SmileIcon />
          每日笑话
        </Link>
        <nav className="nav-links">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={pathname === l.href ? "active" : ""}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <button
          className="btn"
          onClick={toggleTheme}
          aria-label="切换主题"
          title="切换主题"
        >
          {dark ? "☀️" : "🌙"}
        </button>
      </div>
    </header>
  );
}
