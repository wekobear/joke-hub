"use client";

export default function FavoriteButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`btn${active ? " active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      title={active ? "取消收藏" : "收藏"}
    >
      {active ? "★ 已收藏" : "☆ 收藏"}
    </button>
  );
}
