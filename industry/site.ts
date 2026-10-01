// 站点身份：站名、文案、对外地址的唯一出处（仿 AIHOT industry/site.ts）。
// 页面 metadata、导航品牌、RSS channel、llms.txt 全部引用这里；
// 改站名只改这个文件。纯数据、无依赖，可被 node 直接加载（可擦除语法）。

export const SITE = {
  /** 站名（页面标题、导航、RSS channel） */
  name: "每日笑话",
  /** 一句话定位（meta description、llms.txt） */
  description: "每天一期，短笑话与长篇佳作，轻量阅读。",
  /** 更详细的介绍（llms.txt、关于文案） */
  about:
    "AI 原创的中文笑话日刊：每天一期，10 条短内容（短笑话、相声、讽刺对话）加 1 段脱口秀，早上 9 点后发布。",
  /** 对外站点地址（RSS/Sitemap/llms.txt 里的绝对链接） */
  url: "https://wekobear-joke-hub.netlify.app",
  locale: "zh-CN",
  /** 首页每日一句（按日期轮换，服务端定值避免水合闪烁） */
  taglines: [
    "阅读本页可能引起嘴角上扬、同事侧目等副作用。",
    "笑话均经人工质检，笑点过低者请酌情阅读。",
    "据不完全统计，读完的人 87% 会心一笑，13% 会心一酸。",
    "今日份快乐已备好，请按顺序笑，谢谢配合。",
    "blob 已替你试笑过一遍，安全。",
  ],
} as const;

/** 首页每日一句：按日期字符码稳定轮换。 */
export function pickTagline(date: string): string {
  let sum = 0;
  for (const ch of date) sum += ch.charCodeAt(0);
  return SITE.taglines[sum % SITE.taglines.length];
}
