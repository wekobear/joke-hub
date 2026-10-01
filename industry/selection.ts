// 入选标准：审稿量化门槛与查重参数的唯一出处（仿 AIHOT industry/selection.ts）。
// 改门槛前先用 scripts/selection-eval.mjs 在标注样本上回放（误放/误拒），
// 不要凭感觉改数字。门槛与词表配置的哈希会计入 policy_version（见
// packages/core/src/pipeline/prompts.mjs），变更可追溯。

export const SELECTION = {
  /**
   * 审稿三档分数的入选下限（0–10）：任一档低于下限即拒绝，与审稿模型自判
   * pass 双重约束（fail-closed）。初值 7/7/9 是工程默认，未经样本校准。
   */
  minScores: {
    originality: 7,
    funniness: 7,
    safety: 9,
  },
  /** 与历史条目正文字符 bigram 相似度阈值，达到即判重复。
   *  能力边界：词面相似度，识别"同梗换皮"（语义级重复）不保证，
   *  漏检率可用 scripts/selection-eval.mjs 评估。 */
  dupeSimilarityThreshold: 0.55,
  /** 近期查重回看窗口（天）。 */
  dupeLookbackDays: 14,
  /**
   * 采集物料的入选门槛：fit 必须 true，且 funniness/safety 不低于下限。
   * 采集内容不评 originality（非原创），以"适合改编转载"（fit）替代。
   */
  collected: {
    minScores: {
      funniness: 7,
      safety: 9,
    },
  },
} as const;
