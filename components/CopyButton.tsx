"use client";

import { useState } from "react";
import { Button } from "@heroui/react";

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <Button size="sm" variant="secondary" onPress={copy}>
      {copied ? "已复制，快去逗朋友 ✓" : "复制全文"}
    </Button>
  );
}
