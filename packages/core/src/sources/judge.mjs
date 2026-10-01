// 采集评审：对物料池待评审条目批量打分（本地 claude CLI 一次调用）。
// fail-closed：评审调用失败或输出不可解析 = 全部按不合格跳过（不挡住采集主流程），
// 下次 collect 会重新评审（judged 仍为 0）。
import { runClaudeText, extractJson } from "../pipeline/claude-cli.mjs";
import { buildJudgePrompt } from "../pipeline/prompts.mjs";

/**
 * 采集门槛复核（与 applyJudgements 同一规则）：fit 必须 true 且分数达标。
 * 供 selection-eval 回放标注样本使用。
 */
export function collectedVerdict(sample, minScores) {
  if (sample.fit !== true) return false;
  return sample.scores.funniness >= minScores.funniness && sample.scores.safety >= minScores.safety;
}

/**
 * 严格解析评审输出。返回与候选一一对应的判定数组：
 *   [{ id, fit, funniness, safety, category, reason }]
 * 校验失败返回 { ok: false, error }，调用方按全部不合格处理。
 */
export function parseJudgeOutput(raw, candidates) {
  if (!Array.isArray(raw)) return { ok: false, error: "评审输出不是数组" };
  const byI = new Map();
  for (const row of raw) {
    if (typeof row !== "object" || row === null) return { ok: false, error: "评审行不是对象" };
    byI.set(Number(row.i), row);
  }
  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const row = byI.get(i);
    if (!row) return { ok: false, error: `候选 #${i} 未被评审（reviewedIds 不全）` };
    const { fit, funniness, safety, category } = row;
    if (typeof fit !== "boolean") return { ok: false, error: `#${i} fit 不是布尔` };
    const num = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10;
    if (!num(funniness) || !num(safety)) return { ok: false, error: `#${i} funniness/safety 非法（0-10 整数）` };
    if (typeof category !== "string" || !category.trim()) {
      return { ok: false, error: `#${i} 缺少 category 归类` };
    }
    out.push({
      id: candidates[i].id,
      fit,
      funniness,
      safety,
      category: category.trim(),
      reason: typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null,
    });
  }
  return { ok: true, results: out };
}

/**
 * 评审物料池的待评审条目。deps.judge 供测试注入（默认走真实 claude CLI）。
 * 返回 { judged, passed, failed, error }。
 */
export async function judgePending(backend, { judge } = {}) {
  const candidates = await backend.listPendingJudgement(30);
  if (!candidates.length) return { judged: 0, passed: 0, failed: 0, error: null };

  const runJudge = judge ?? (async (cands) => {
    const prompt = buildJudgePrompt({ candidates: cands });
    const { text } = await runClaudeText(prompt, { timeoutMs: 600_000, label: "judge-collected" });
    return extractJson(text, { label: "judge-collected" });
  });

  let parsed;
  try {
    const raw = await runJudge(candidates);
    parsed = parseJudgeOutput(raw, candidates);
  } catch (e) {
    parsed = { ok: false, error: `评审调用失败：${e.message}` };
  }
  if (!parsed.ok) {
    // fail-closed：输出不可用 → 不更新判定（保持 judged=0），下次重新评审
    return { judged: 0, passed: 0, failed: 0, error: parsed.error };
  }
  const minScores = (await import("../pipeline/config.mjs")).SELECTION.collected.minScores;
  await backend.applyJudgements(parsed.results, minScores);
  const passed = parsed.results.filter((r) => r.fit).length;
  return { judged: parsed.results.length, passed, failed: parsed.results.length - passed, error: null };
}
