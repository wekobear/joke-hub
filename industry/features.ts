// 功能开关（仿 AIHOT industry/features.ts）：每个布尔决定一个公开出口
// 是否存在。关闭 = 路由 404，部署者可按需裁剪，不需要改代码。

export const FEATURES = {
  /** /feed.xml 日刊 RSS */
  rss: true,
  /** /llms.txt 给大模型的站点说明 */
  llmsTxt: true,
  /** /sitemap.xml + /robots.txt（两者一体开关） */
  seo: true,
} as const;
