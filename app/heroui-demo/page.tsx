"use client";

// HeroUI v3 组件参考页：Button / Card / Input 的用法示例。
// 全站已完成 HeroUI 迁移，本页仅作组件写法速查，不接入站点导航。

import { useState } from "react";
import { Button, Card, Input, Label } from "@heroui/react";

export default function HeroUIDemoPage() {
  const [keyword, setKeyword] = useState("");

  return (
    <main className="container pb-20">
      <h1 className="mt-4 mb-1 text-[22px] font-semibold">HeroUI v3 组件参考</h1>
      <p className="mb-6 text-sm text-muted">
        Button / Card / Input · Tailwind CSS v4 + @heroui/styles
      </p>

      <div className="flex max-w-[720px] flex-col gap-5">
        <Card>
          <Card.Header>
            <Card.Title>Button</Card.Title>
            <Card.Description>variant / size / isDisabled / onPress</Card.Description>
          </Card.Header>
          <Card.Content className="mt-1 flex flex-col gap-4">
            <div className="flex flex-wrap gap-3">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="tertiary">Tertiary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button isDisabled>Disabled</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onPress={() => window.alert("你点击了 Small 按钮")}>
                Small
              </Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
            </div>
          </Card.Content>
        </Card>

        <Card className="w-full max-w-xl">
          <Card.Header className="gap-1">
            <Card.Title>Card</Card.Title>
            <Card.Description>Header / Content / Footer 复合结构</Card.Description>
          </Card.Header>
          <Card.Content>
            <p className="text-sm text-muted">
              HeroUI v3 采用 BEM 类名（.card、.card__header 等），可用 className
              叠加 Tailwind 工具类。
            </p>
          </Card.Content>
          <Card.Footer className="gap-3">
            <Button size="sm">确认</Button>
            <Button size="sm" variant="secondary">
              取消
            </Button>
          </Card.Footer>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Input</Card.Title>
            <Card.Description>Label + 受控输入</Card.Description>
          </Card.Header>
          <Card.Content className="mt-1">
            <div className="flex max-w-sm flex-col gap-1">
              <Label htmlFor="heroui-demo-input">关键词</Label>
              <Input
                id="heroui-demo-input"
                placeholder="输入点什么试试…"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </div>
            <span className="mt-2 block text-sm text-muted">
              当前输入：{keyword || "（空）"}
            </span>
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
