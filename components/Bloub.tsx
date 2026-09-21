"use client";

// Bloub 吉祥物：圆滚滚的 blob + 两只白色胶囊眼睛。
// 形象与动画灵感来自开源项目 bloub（MIT，https://github.com/jeremy-prt/bloub），
// 这里是手绘简化的 React/SVG 版：idle 呼吸眨眼、laugh 笑弯了眼、sleep 睡着。
// 身体颜色跟随 text-foreground（暗色模式自动反转），眼睛走 --bloub-eye 变量。

export type BloubMood = "idle" | "laugh" | "sleep";

export default function Bloub({
  size = 96,
  mood = "idle",
  className = "",
}: {
  size?: number;
  mood?: BloubMood;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 text-foreground ${className}`}
    >
      <g className="bloub-breathe">
        {/* 身体：略带不对称的有机圆形 */}
        <path
          d="M50 7c13.5-.6 26.4 7.2 33.2 19.4 6.6 11.8 5.7 27.3-1.6 38.9C74.6 76.7 62 87 48.6 86.8 35 86.6 21.6 76.6 15.4 63.4 9.1 50 11 32.8 20.6 21.4 27.7 13.1 38.7 7.5 50 7Z"
          fill="currentColor"
        />
        {mood === "laugh" ? (
          <>
            {/* 笑弯的眼睛（∩∩）+ 张开的嘴 */}
            <g
              stroke="var(--bloub-eye)"
              strokeWidth="5.5"
              strokeLinecap="round"
              fill="none"
            >
              <path d="M31 51q7-10 14 0" />
              <path d="M55 51q7-10 14 0" />
            </g>
            <path
              d="M39 62q11 12 22 0z"
              fill="var(--bloub-eye)"
              opacity="0.95"
            />
          </>
        ) : mood === "sleep" ? (
          <>
            {/* 睡觉：两条横线眼 + 上浮的 z z */}
            <g
              stroke="var(--bloub-eye)"
              strokeWidth="5"
              strokeLinecap="round"
            >
              <path d="M31 49h12" />
              <path d="M57 49h12" />
            </g>
            <g
              stroke="var(--bloub-eye)"
              strokeWidth="3.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              opacity="0.9"
            >
              <path d="M74 28h9l-9 9h9" />
              <path d="M88 14h6.5l-6.5 6.5h6.5" />
            </g>
          </>
        ) : (
          /* 默认：两只竖直胶囊眼，周期性眨眼 */
          <g className="bloub-blink" fill="var(--bloub-eye)">
            <rect x="33" y="37" width="10.5" height="23" rx="5.2" />
            <rect x="56.5" y="37" width="10.5" height="23" rx="5.2" />
          </g>
        )}
      </g>
    </svg>
  );
}
