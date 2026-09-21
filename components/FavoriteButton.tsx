"use client";

import { Button, Tooltip } from "@heroui/react";

export default function FavoriteButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip delay={0}>
      <Button
        isIconOnly
        size="sm"
        variant={active ? "primary" : "tertiary"}
        aria-pressed={active}
        aria-label={active ? "取消收藏" : "收藏"}
        onPress={onClick}
      >
        {active ? "★" : "☆"}
      </Button>
      <Tooltip.Content showArrow placement="top">
        <Tooltip.Arrow />
        <p>{active ? "取消收藏（blob 装作没看见）" : "收藏！blob 会记住你"}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}
