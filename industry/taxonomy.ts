// 内容分类体系：格式、分类白名单、每日配比、长度边界、原创来源声明、发布门禁。
// 这是"改定位不改代码"的核心文件：校验器、提示词、页面与流水线全部从这里取值。
// 纯数据 + 纯函数，无依赖（可擦除语法：不用 enum/namespace/参数属性）。

/** 四种内容形态（公开 API 字段，本轮固定，增删属 API 变更）。 */
export const FORMATS = ["短笑话", "相声", "讽刺对话", "脱口秀"] as const;

/** 内容来源类别（通用内容 schema 用；每日自动流水线仅允许 original）。 */
export const SOURCE_KINDS = ["original", "adapted", "example"] as const;

/**
 * 每期结构（v0.5.0 起）：10 条短内容 + 1 段脱口秀。
 * 短内容 = 采集改编（目标 8 条，来自外部信源物料池）+ 原创（基线 2 条）；
 * 采集不足时用原创补足（配比降级会在运行记录中体现）。
 * shortCount 可在 3–99 内调整；talkCount 本轮固定为 1（-talk id 唯一性约束）。
 * 相声/讽刺对话的最低条数不再是硬合同（采集内容的形态不可控），由提示词引导。
 */
export const DAILY_REQUIREMENT = {
  shortCount: 10,
  talkCount: 1,
  collectedShortCount: 8, // 采集改编目标条数（0 到 shortCount-1 内可调）
  originalShortCount: 2, // 原创短内容基线条数
};

/** 分类白名单：prompt 限定从中选择，校验器硬校验（超出即拒绝）。 */
export const DAILY_CATEGORIES = [
  "生活", "职场", "程序员", "养宠", "家庭", "校园",
  "健康", "运动", "旅行", "美食", "购物", "社交",
  "钓鱼", "社会", "科技", "情感",
];

/** 原创条目的固定来源声明（v0.5.0 起仅适用原创短内容与脱口秀；
 * 采集改编条目 source.kind="adapted"，label/url 来自信源与原文链接）。 */
export const DAILY_SOURCE = { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" };

/** 长度边界（字符数，含两端）。 */
export const LIMITS = {
  title: [2, 30],
  shortBody: [30, 600],
  talkBody: [300, 5000],
  issueTitle: [2, 30],
  issueDescription: [4, 60],
} as const;

/** 上海时区默认发布门禁：内容日期当天 09:00（Asia/Shanghai）之后才允许发布。 */
export const PUBLISH_NOT_BEFORE = "09:00";

/**
 * 配置可实现性校验：任何消费者 import 本包即触发（fail-fast）。
 * 不可实现的配置在这里直接抛错，而不是等到生产/校验时才莫名失败。
 */
export function validateTaxonomy(): void {
  const r = DAILY_REQUIREMENT;
  if (!Number.isInteger(r.shortCount) || r.shortCount < 3 || r.shortCount > 99) {
    throw new Error(`taxonomy: shortCount 必须是 3–99 的整数，当前 ${r.shortCount}`);
  }
  if (r.talkCount !== 1) {
    throw new Error(`taxonomy: talkCount 本轮固定为 1（-talk id 唯一性约束），当前 ${r.talkCount}`);
  }
  if (!Number.isInteger(r.collectedShortCount) || r.collectedShortCount < 0 || r.collectedShortCount >= r.shortCount) {
    throw new Error(`taxonomy: collectedShortCount 必须在 0 到 shortCount-1，当前 ${r.collectedShortCount}`);
  }
  if (r.collectedShortCount + r.originalShortCount !== r.shortCount) {
    throw new Error(
      `taxonomy: collectedShortCount(${r.collectedShortCount}) + originalShortCount(${r.originalShortCount}) 必须等于 shortCount(${r.shortCount})`,
    );
  }
  if (DAILY_CATEGORIES.length < 1 || new Set(DAILY_CATEGORIES).size !== DAILY_CATEGORIES.length) {
    throw new Error("taxonomy: 分类白名单不能为空且不能有重复");
  }
  if (LIMITS.shortBody[0] >= LIMITS.shortBody[1] || LIMITS.talkBody[0] >= LIMITS.talkBody[1]) {
    throw new Error("taxonomy: 长度边界必须 min < max");
  }
}

validateTaxonomy();
