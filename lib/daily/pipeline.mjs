// 每日内容流水线：生产 → 独立校验 → 原子认领 → 时间门禁发布 → 公开 API 核验。
//
// 合同要点（与验收标准一一对应）：
//   - 幂等：同日期已发布（且 hash 一致）→ 不再生产、不重写库，只做读回核验；
//   - 覆盖保护：同日期已存在不同 hash 的已发布内容 → 拒绝（失败重跑不能变成覆盖发布）；
//   - 校验拒绝不发布：程序化硬校验 + 独立 CLI 审稿，任一拒绝 → 最多一次修稿，
//     仍失败则如实保存失败材料并以非零退出，绝不入库；
//   - 时间门禁：内容日期当天 09:00（Asia/Shanghai）前不发布；未来日期绝不发布；
//     错过门禁后的补发（迟到发布）允许；
//   - 并发互斥：本地目录锁（生产互斥）+ 云端/SQLite 日期原子认领（发布协调），
//     同日并发只有一个进程推进；
//   - 模型自报不作为验收：生产与审稿是两次独立 CLI 调用，最终以程序化校验 +
//     写库后从公开读取路径读回比对为准；复用本地成品时 hash 重算、校验重跑、
//     审稿重新执行并与该 hash 绑定，不信任历史记录里的 pass。
//
// deps 注入（produce/review）供自测使用；生产默认实现走真实本地 claude CLI。

import fs from "node:fs";
import path from "node:path";
import { validateDailyPackage } from "./validate.mjs";
import {
  PUBLISH_NOT_BEFORE, DUPE_LOOKBACK_DAYS, dailyRunsDir,
  checkPublishGate, shanghaiNow, contentHashStable, pipelineLogFile,
} from "./config.mjs";
import {
  RunRecord, newRunId, acquireLock, releaseLock,
  loadLatestRun, loadValidatedPackage, saveValidatedPackage, saveRejectedPackage,
} from "./runs.mjs";

function lockDbPathSafe() {
  return path.join(dailyRunsDir(), ".pipeline-lock.sqlite");
}
import { runClaudeText, extractJson } from "./claude-cli.mjs";
import { buildProducePrompt, buildRevisePrompt, buildReviewPrompt } from "./prompts.mjs";

export const EXIT = { OK: 0, REJECTED: 2, GATE_WAITING: 3, ERROR: 4 };

/** 审稿判定的严格结构校验：不接受缺字段、越界分数、pass 与 reasons 矛盾。 */
export function parseReviewVerdict(verdict) {
  if (typeof verdict !== "object" || verdict === null) {
    return { pass: false, reasons: ["审稿输出不是 JSON 对象"], scores: null };
  }
  const { pass, reasons, scores } = verdict;
  if (typeof pass !== "boolean") {
    return { pass: false, reasons: ["审稿输出缺少布尔 pass 字段"], scores: null };
  }
  if (!Array.isArray(reasons)) {
    return { pass: false, reasons: ["审稿输出缺少 reasons 数组"], scores: null };
  }
  if (!scores || typeof scores !== "object"
    || !["originality", "funniness", "safety"].every((k) =>
      typeof scores[k] === "number" && scores[k] >= 0 && scores[k] <= 10)) {
    return { pass: false, reasons: ["审稿输出缺少合法的 scores（originality/funniness/safety 0-10）"], scores: null };
  }
  const reasonList = reasons.map(String);
  if (pass && reasonList.length > 0) {
    // pass=true 却给出理由：输出自相矛盾，fail-closed
    return { pass: false, reasons: [`审稿输出矛盾（pass=true 但给出理由）：${reasonList.join("；")}`], scores };
  }
  if (!pass && reasonList.length === 0) {
    return { pass: false, reasons: ["审稿未通过但未给出原因"], scores };
  }
  return { pass, reasons: pass ? [] : reasonList, scores };
}

// ---------- 依赖：真实实现（本地 claude CLI） ----------

async function realProduce({ date, recentTitles, reasons, previousJson }) {
  const prompt = reasons
    ? buildRevisePrompt({ date, previousJson: previousJson ?? "", reasons })
    : buildProducePrompt({ date, recentTitles });
  const text = await runClaudeText(prompt, { timeoutMs: 900_000, label: "produce" });
  return extractJson(text, { label: "produce" });
}

async function realReview({ date, content, recentTitles }) {
  try {
    const prompt = buildReviewPrompt({
      date, packageJson: JSON.stringify(content, null, 2), recentTitles,
    });
    const text = await runClaudeText(prompt, { timeoutMs: 600_000, label: "review" });
    const verdict = extractJson(text, { label: "review" });
    const parsed = parseReviewVerdict(verdict);
    // 每条内容都已审：reviewedIds 必须覆盖包内全部 id
    const ids = new Set(content.jokes.map((j) => j.id));
    const reviewed = Array.isArray(verdict.reviewedIds) ? new Set(verdict.reviewedIds.map(String)) : null;
    if (!reviewed || [...ids].some((id) => !reviewed.has(id))) {
      parsed.pass = false;
      parsed.reasons = [...parsed.reasons, "审稿输出未确认逐条审阅全部条目（reviewedIds 缺失或不全）"];
    }
    return parsed;
  } catch (e) {
    // fail-closed：审稿调用失败或输出不可解析 = 未通过，绝不当作通过
    return { pass: false, reasons: [`独立审稿调用失败：${e.message}`], scores: null };
  }
}

// ---------- 进度与摘要（产品状态全部落在 data/daily-runs/<date>/ 内） ----------

function createProgress(date) {
  const logFile = pipelineLogFile(date);
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try {
      fs.mkdirSync(logFile.slice(0, logFile.lastIndexOf("/")), { recursive: true });
      fs.appendFileSync(logFile, line + "\n");
    } catch {}
    console.log(line);
  };
}

// ---------- 读取后端统一抽象（SQLite / Supabase 同接口） ----------

async function openBackend() {
  const { supabaseReadConfig } = await import("../supabase-store.mjs");
  const cfg = supabaseReadConfig(); // null = 本地 SQLite 模式；配置不完整会抛错
  if (!cfg) {
    const { openDb, defaultDbPath } = await import("../store.mjs");
    return {
      kind: "sqlite",
      db: openDb(defaultDbPath(), null), // 不做种子导入：内容只由流水线/显式导入写入
      async recentForDupe(date) {
        const { recentJokesForDupe } = await import("../store.mjs");
        return recentJokesForDupe(this.db, date, DUPE_LOOKBACK_DAYS);
      },
      async getRun(date) {
        const { getDailyRun } = await import("../store.mjs");
        return getDailyRun(this.db, date);
      },
      async claim(date, hash) {
        const { dailyClaim } = await import("../store.mjs");
        return dailyClaim(this.db, date, hash);
      },
      async publish(date, hash, content) {
        const { dailyPublish } = await import("../store.mjs");
        return dailyPublish(this.db, date, hash, content);
      },
      async readIssue(date) {
        const { getIssue, getJokesByIds } = await import("../store.mjs");
        const issue = getIssue(this.db, date);
        return issue ? { issue, items: getJokesByIds(this.db, issue.jokeIds) } : null;
      },
    };
  }
  const sb = await import("../supabase-store.mjs");
  return {
    kind: "supabase",
    async recentForDupe(date) {
      return sb.recentJokesForDupe(date, DUPE_LOOKBACK_DAYS);
    },
    async getRun(date) {
      return sb.getDailyRun(date);
    },
    async claim(date, hash) {
      return sb.dailyClaim(date, hash);
    },
    async publish(date, hash, content) {
      return sb.dailyPublish(content, date, hash);
    },
    async readIssue(date) {
      const issue = await sb.getIssue(date);
      if (!issue) return null;
      return { issue, items: await sb.getJokesByIds(issue.jokeIds) };
    },
  };
}

// ---------- 发布内容与读取结果的比对 ----------

export function comparePackage(content, { issue, items }) {
  const diffs = [];
  if (!issue) return ["读取结果缺少该期次"];
  if (issue.date !== content.issues[0].date) diffs.push(`期次日期不一致: 库=${issue.date}`);
  if (issue.title !== content.issues[0].title) diffs.push(`期次标题不一致: 库=${issue.title}`);
  if (issue.description !== content.issues[0].description) diffs.push("期次描述不一致");
  const want = content.jokes;
  if (items.length !== want.length) diffs.push(`条目数不一致: 库=${items.length} 期望=${want.length}`);
  const byId = new Map(items.map((j) => [j.id, j]));
  for (const w of want) {
    const g = byId.get(w.id);
    if (!g) {
      diffs.push(`缺少条目 ${w.id}`);
      continue;
    }
    for (const k of ["title", "body", "category", "format", "date"]) {
      if (g[k] !== w[k]) diffs.push(`条目 ${w.id}.${k} 不一致`);
    }
    if (g.featured !== w.featured) diffs.push(`条目 ${w.id}.featured 不一致`);
    if (JSON.stringify(g.source) !== JSON.stringify(w.source)) {
      diffs.push(`条目 ${w.id}.source 不一致`);
    }
  }
  // 期次展示顺序也必须一致（网站按该顺序展示）
  if (JSON.stringify(issue.jokeIds) !== JSON.stringify(content.issues[0].jokeIds)) {
    diffs.push("期次条目顺序不一致");
  }
  return diffs;
}

// ---------- 主流程 ----------

/**
 * 运行一次每日流水线。
 * options:
 *   date         目标日期（默认上海今天）
 *   mode         "run"（默认，全流程含发布）| "prepare"（只生产+校验+本地保存）
 *   notBefore    发布门禁（默认 09:00；云端 DB 侧固定 09:00 硬门禁）
 *   maxRevisions 修稿次数上限（默认 1，即最多一次修稿）
 *   siteUrl      网站 HTTP 核验地址（默认探测本地 4310；JOKE_SITE_URL 可配）
 *   skipHttp     跳过 HTTP 核验
 * 返回 { exitCode, status, summary }；summary 即产品运行结果（RunRecord.data）。
 */
export async function runPipeline(options = {}, deps = {}) {
  const {
    date = shanghaiNow().date,
    mode = "run",
    notBefore = PUBLISH_NOT_BEFORE,
    maxRevisions = 1,
    siteUrl = process.env.JOKE_SITE_URL ?? "http://127.0.0.1:4310",
    skipHttp = false,
  } = options;

  const produce = deps.produce ?? realProduce;
  const review = deps.review ?? realReview;

  // 0. 日期合法性必须最先验证：date 会拼进运行目录/日志路径，先防路径穿越
  try {
    (await import("./validate.mjs")).assertTargetDate(date);
  } catch (e) {
    console.error(`FAIL ${e.message}`);
    return { exitCode: EXIT.ERROR, status: "failed", summary: { date, status: "failed", errors: [e.message] } };
  }

  const progress = deps.progress ?? createProgress(date);
  const run = new RunRecord(date, newRunId());
  const finish = (status, exitCode) => {
    run.finish(status);
    return { exitCode, status, summary: run.data };
  };

  progress(`=== 每日流水线启动 date=${date} mode=${mode} runId=${run.data.runId} ===`);

  // 1. 本地互斥锁：流水线已在跑则直接退出（不并发重复执行）
  let lockHandle = null;
  try {
    lockHandle = acquireLock();
  } catch (e) {
    run.fail(`获取运行锁失败：${e.message}`);
    progress(`FAIL 获取运行锁失败：${e.message}`);
    return finish("failed", EXIT.ERROR);
  }
  if (!lockHandle) {
    run.fail("流水线已在运行（锁被存活进程持有），本进程退出以避免并发重复执行");
    progress(`SKIP ${date} 已有运行中的流水线（并发保护生效）`);
    return finish("failed", EXIT.ERROR);
  }
  run.stage("lock", "ok", { lockDb: lockDbPathSafe() });
  try {
    return await pipelineBody();
  } finally {
    releaseLock(lockHandle);
  }

  async function pipelineBody() {
    // 2. 后端判定与连接（配置不完整时 supabaseReadConfig 抛错 → 明确失败，不静默回退）
    let backend;
    try {
      backend = await openBackend();
    } catch (e) {
      run.fail(`数据后端配置错误：${e.message}`);
      progress(`FAIL 数据后端配置错误：${e.message}`);
      return finish("failed", EXIT.ERROR);
    }
    run.patch({ backend: backend.kind });
    progress(`数据后端：${backend.kind}`);

    const nowSh = shanghaiNow();

    // 3. run/发布类模式禁止未来日期（prepare 允许提前准备，但不写库不发布）
    if (mode !== "prepare" && date > nowSh.date) {
      run.fail(`内容日期 ${date} 在未来（上海今天 ${nowSh.date}）：发布类模式禁止，请用 --prepare 提前准备`);
      progress(`FAIL 拒绝为未来日期 ${date} 执行发布类流程`);
      return finish("failed", EXIT.ERROR);
    }

    // 4. 恢复检查：云端/本地运行行状态
    let cloudRun = null;
    try {
      cloudRun = await backend.getRun(date);
    } catch (e) {
      run.fail(`读取运行记录失败：${e.message}`);
      progress(`FAIL 读取运行记录失败：${e.message}`);
      return finish("failed", EXIT.ERROR);
    }
    if (cloudRun?.status === "published") {
      // 已发布：进入幂等路径（绝不重新生产、绝不重写）
      progress(`已发布记录存在（hash=${cloudRun.contentHash.slice(0, 12)}…），走幂等核验`);
      return await idempotentVerifyPath(backend, date, cloudRun, run, finish, {
        siteUrl, skipHttp, progress,
      });
    }

    // 5. 准备阶段：复用（重校验+重审稿）或生产
    let content = null;
    let hash = null;
    let reusedPackage = null;
    try {
      reusedPackage = loadValidatedPackage(date);
    } catch (e) {
      run.fail(`${e.message}`);
      progress(`FAIL ${e.message}`);
      return finish("failed", EXIT.ERROR);
    }

    let revision = 0;
    let lastErrors = [];
    let lastRaw = null;

    if (reusedPackage) {
      // 复用：hash 重算 + 程序化校验重跑（绝不信任包内保存的 hash/pass）
      hash = contentHashStable(reusedPackage.content);
      let recheck;
      try {
        recheck = validateDailyPackage(reusedPackage.content, {
          date,
          recentJokes: await backend.recentForDupe(date),
        });
      } catch (e) {
        recheck = { ok: false, errors: [`复检异常：${e.message}`] };
      }
      run.stage("reuse-revalidate", recheck.ok ? "ok" : "failed", {
        hash, errors: recheck.ok ? null : recheck.errors,
      });
      if (recheck.ok) {
        content = reusedPackage.content;
        progress(`复用本地成品并重校验通过（hash=${hash.slice(0, 12)}…），发布前将重新独立审稿`);
      } else {
        progress(`复用成品复检未通过（${recheck.errors.length} 项），转重新生产`);
      }
    }

    while (!content) {
      // 生产（真实 claude CLI 或注入实现）
      let raw;
      try {
        const recent = await backend.recentForDupe(date);
        const recentTitles = [...new Set(recent.map((j) => j.title))];
        raw = await produce({
          date,
          recentTitles,
          reasons: revision === 0 ? null : lastErrors,
          previousJson: lastRaw ? JSON.stringify(lastRaw, null, 2) : null,
        });
      } catch (e) {
        run.stage("produce", "failed", { attempt: revision + 1 }, e.message);
        // CLI 级失败也允许消耗一次修稿机会（如输出 JSON 损坏）
        if (revision < maxRevisions) {
          revision++;
          lastErrors = [e.message];
          lastRaw = null;
          progress(`生产调用失败，进行第 ${revision}/${maxRevisions} 次修稿：${e.message}`);
          continue;
        }
        run.fail(`生产失败（含 ${maxRevisions} 次修稿机会）：${e.message}`);
        progress(`FAIL 生产失败：${e.message}`);
        saveRejectedPackage(date, run.data.runId, { error: e.message }, [e.message]);
        return finish("rejected", EXIT.REJECTED);
      }
      lastRaw = raw;
      run.stage("produce", "ok", { attempt: revision + 1 });

      // 程序化硬校验（与生产相互独立）
      let verdict;
      try {
        const recent = await backend.recentForDupe(date);
        verdict = validateDailyPackage(raw, { date, recentJokes: recent });
      } catch (e) {
        verdict = { ok: false, content: null, errors: [`校验器异常：${e.message}`] };
      }
      lastErrors = verdict.errors;
      run.stage("validate", verdict.ok ? "ok" : "failed", {
        attempt: revision + 1, errors: verdict.ok ? null : verdict.errors,
      });

      const needRevision = () => revision < maxRevisions;

      if (!verdict.ok) {
        if (needRevision()) {
          revision++;
          progress(`程序化校验拒绝（${verdict.errors.length} 项），进行第 ${revision}/${maxRevisions} 次修稿`);
          continue;
        }
        // 校验拒绝：不发布，如实保存失败材料
        const file = saveRejectedPackage(date, run.data.runId, raw, verdict.errors);
        run.patch({ packagePath: file });
        run.fail(`校验拒绝（修稿 ${revision}/${maxRevisions} 后仍未通过）：${verdict.errors.join("；")}`);
        verdict.errors.forEach((er) => progress(`REJECT ${er}`));
        progress(`FAIL 校验未通过，已保存失败材料 ${file}，未发布`);
        return finish("rejected", EXIT.REJECTED);
      }

      // 独立 CLI 审稿（与生产无共享上下文的第二次调用）
      const recent = await backend.recentForDupe(date);
      const recentTitles = [...new Set(recent.map((j) => j.title))];
      const reviewVerdict = await review({ date, content: verdict.content, recentTitles });
      run.stage("review", reviewVerdict.pass ? "ok" : "failed", {
        attempt: revision + 1,
        scores: reviewVerdict.scores,
        reasons: reviewVerdict.pass ? null : reviewVerdict.reasons,
      });
      if (!reviewVerdict.pass) {
        if (needRevision()) {
          revision++;
          lastErrors = reviewVerdict.reasons;
          progress(`独立审稿拒绝，进行第 ${revision}/${maxRevisions} 次修稿：${reviewVerdict.reasons.join("；")}`);
          continue;
        }
        const file = saveRejectedPackage(date, run.data.runId, raw, reviewVerdict.reasons);
        run.patch({ packagePath: file });
        run.fail(`独立审稿拒绝（修稿 ${revision}/${maxRevisions} 后仍未通过）：${reviewVerdict.reasons.join("；")}`);
        reviewVerdict.reasons.forEach((r) => progress(`REJECT(review) ${r}`));
        progress(`FAIL 独立审稿未通过，已保存失败材料 ${file}，未发布`);
        return finish("rejected", EXIT.REJECTED);
      }

      content = verdict.content;
      hash = contentHashStable(content);
      const pkgPath = saveValidatedPackage(date, content, hash, {
        revision, reviewed: true, backend: backend.kind,
      });
      run.patch({ contentHash: hash, packagePath: pkgPath });
      progress(`生产+校验+独立审稿通过（第 ${revision + 1} 次生产），hash=${hash.slice(0, 12)}…`);
    }

    if (mode === "prepare") {
      run.stage("publish", "skipped", { reason: "prepare 模式：不写库不发布" });
      progress(`PREPARED ${date} 内容已就绪（hash=${hash.slice(0, 12)}…），按设计未写库未发布`);
      return finish("prepared", EXIT.OK);
    }

    // 6. 原子认领（并发/覆盖保护；生产互斥由本地锁承担，这里协调发布权）
    let claimVerdict;
    try {
      claimVerdict = await backend.claim(date, hash);
    } catch (e) {
      run.fail(`认领失败（可能该日期已发布不同内容）：${e.message}`);
      progress(`FAIL 认领失败：${e.message}`);
      return finish("failed", EXIT.ERROR);
    }
    run.stage("claim", "ok", { verdict: claimVerdict });
    if (claimVerdict === "already_published") {
      progress("认领结果 already_published：该日期已发布同 hash 内容，进入幂等核验");
      const cloudRun2 = await backend.getRun(date);
      return await idempotentVerifyPath(backend, date, cloudRun2, run, finish, {
        siteUrl, skipHttp, progress, expectHash: hash,
      });
    }

    // 6b. 复用内容的独立审稿绑定：成品不是本次运行生产的 → 重新审稿一次，
    //     让审稿判定与本次发布的 hash 绑定（不信任历史 pass）
    if (reusedPackage && content === reusedPackage.content) {
      const recent = await backend.recentForDupe(date);
      const recentTitles = [...new Set(recent.map((j) => j.title))];
      const reviewVerdict = await review({ date, content, recentTitles });
      run.stage("review-rebind", reviewVerdict.pass ? "ok" : "failed", {
        hash,
        scores: reviewVerdict.scores,
        reasons: reviewVerdict.pass ? null : reviewVerdict.reasons,
      });
      if (!reviewVerdict.pass) {
        run.fail(`复用成品的重新审稿未通过（hash=${hash.slice(0, 12)}…）：${reviewVerdict.reasons.join("；")}`);
        reviewVerdict.reasons.forEach((r) => progress(`REJECT(rebind-review) ${r}`));
        progress("FAIL 复用内容审稿未通过，未发布（下次运行将重新生产）");
        return finish("rejected", EXIT.REJECTED);
      }
    }

    // 7. 发布时间门禁（本机预检；云端由 RPC 用服务器时钟复核，固定 09:00）
    const gate = checkPublishGate(date, notBefore);
    run.patch({ publishGate: { ok: gate.ok, reason: gate.reason, nowSh: gate.nowSh, notBefore } });
    if (!gate.ok) {
      run.stage("publish", "skipped", { reason: gate.reason });
      progress(`WAIT ${gate.reason}；内容已就绪为 prepared，重跑本命令即可在门禁后发布`);
      return finish("gate-waiting", EXIT.GATE_WAITING);
    }

    // 8. 发布（DB 单事务：日期锁 → 认领复检 → 导入 → 状态写）
    let published;
    try {
      published = await backend.publish(date, hash, content);
    } catch (e) {
      run.fail(`发布失败（未生效或已回滚）：${e.message}`);
      progress(`FAIL 发布失败：${e.message}`);
      return finish("failed", EXIT.ERROR);
    }
    run.stage("publish", "ok", published);
    progress(`PUBLISHED ${date}（status=${published.status}）`);

    // 9. 核验：从公开读取路径读回比对（不是模型自报）
    return await verifyAndFinish(backend, date, content, run, finish, {
      siteUrl, skipHttp, progress,
    });
  }
}

/** 幂等路径：已发布内容只读回核对，绝不重写。 */
async function idempotentVerifyPath(backend, date, cloudRun, run, finish, opts) {
  const stored = await backend.readIssue(date);
  if (!stored) {
    run.fail("运行记录为已发布，但读取期次为空：数据不一致");
    opts.progress(`FAIL ${date} 标记已发布但读不到期次`);
    return finish("failed", EXIT.ERROR);
  }
  // hash 一致性是幂等核验的硬约束：有本地成品 → 与之逐字段比对并重算 hash；
  // 无本地成品 → 从已发布内容完整重建期包（hash 不含全局 notice，可精确重建），
  // 重算 hash 与运行记录比对，并跑完整每日规则校验（不能只查形状）
  let content = null;
  try {
    const reused = loadValidatedPackage(date);
    if (reused) content = reused.content;
  } catch (e) {
    run.fail(String(e.message));
    opts.progress(`FAIL ${e.message}`);
    return finish("failed", EXIT.ERROR);
  }
  let diffs;
  if (content) {
    diffs = comparePackage(content, stored);
  } else {
    content = {
      schemaVersion: 1,
      notice: "(reconstructed-from-db)",
      issues: [{ ...stored.issue }],
      jokes: stored.items,
    };
    try {
      const recheck = validateDailyPackage(content, {
        date,
        recentJokes: await backend.recentForDupe(date),
      });
      // 来源 label 会固定为每日声明，已发布内容与之一致才可能通过；
      // notice 是重建占位值，hash 不覆盖它，不影响比对
      diffs = recheck.errors;
    } catch (e) {
      diffs = [`已发布内容规则复检异常：${e.message}`];
    }
  }
  // 实际重算 hash 并与运行记录绑定比对（无论本地有无成品）
  const recomputed = contentHashStable(content);
  if (cloudRun?.contentHash && recomputed !== cloudRun.contentHash) {
    diffs.push(`hash 一致性失败：重算=${recomputed.slice(0, 12)}… 运行记录=${cloudRun.contentHash.slice(0, 12)}…（内容在发布后被改动，或本地成品与已发布版本不同）`);
  }
  if (opts.expectHash && cloudRun?.contentHash && opts.expectHash !== cloudRun.contentHash) {
    diffs.push(`运行记录 hash 与本次内容不一致：记录=${cloudRun.contentHash}`);
  }
  run.patch({ contentHash: cloudRun.contentHash });
  run.stage("verify", diffs.length ? "failed" : "ok", {
    diffs: diffs.length ? diffs : null, via: backend.kind, idempotent: true,
  });
  if (diffs.length) {
    run.fail(`幂等核验发现不一致：${diffs.join("；")}`);
    diffs.forEach((d) => opts.progress(`MISMATCH ${d}`));
    return finish("failed", EXIT.ERROR);
  }
  const http = await httpVerify(date, content, run, opts);
  if (http?.error) {
    run.fail(http.error);
    return finish("failed", EXIT.ERROR);
  }
  if (http?.skipped) {
    run.fail("已发布但按 --skip-http 跳过网站核验：不算完整成功，去掉该选项重跑以完成核验");
    opts.progress(`OK-WITH-WAIVER ${date} 已发布、数据层核验一致，网站核验被跳过（非完整成功）`);
    return finish("published-unverified", EXIT.ERROR);
  }
  opts.progress(`OK ${date} 已发布且核验一致（幂等复用，未重复生产）`);
  return finish("published", EXIT.OK);
}

/** 核验并收尾。 */
async function verifyAndFinish(backend, date, content, run, finish, opts) {
  const stored = await backend.readIssue(date);
  const diffs = stored ? comparePackage(content, stored) : ["发布后读回期次为空"];
  run.stage("verify", diffs.length ? "failed" : "ok", {
    diffs: diffs.length ? diffs : null, via: backend.kind,
  });
  if (diffs.length) {
    run.fail(`发布后核验不一致：${diffs.join("；")}`);
    diffs.forEach((d) => progress(`MISMATCH ${d}`));
    return finish("failed", EXIT.ERROR);
  }
  const http = await httpVerify(date, content, run, opts);
  if (http?.error) {
    run.fail(http.error);
    return finish("failed", EXIT.ERROR);
  }
  if (http?.skipped) {
    run.fail("已发布但按 --skip-http 跳过网站核验：不算完整成功，去掉该选项重跑以完成核验");
    opts.progress(`OK-WITH-WAIVER ${date} 已发布、数据层核验一致，网站核验被跳过（非完整成功）`);
    return finish("published-unverified", EXIT.ERROR);
  }
  opts.progress(`VERIFIED ${date} 写库内容与公开读取路径、网站公开 API 一致`);
  return finish("published", EXIT.OK);
}

/**
 * 网站 HTTP API 核验：正常发布模式是验收的一部分（网站展示链路），失败即失败。
 * --skip-http 只能标"未验证"，调用方据 skip 标记把终态降为 published-unverified
 * （非零退出，不算完整成功）。
 * 返回 { error } 失败 | { skipped } 跳过 | null 成功。
 */
async function httpVerify(date, content, run, opts) {
  if (opts.skipHttp || !opts.siteUrl) {
    run.stage("verify-http", "skipped", { reason: "--skip-http：未做网站展示链路核验" });
    return { skipped: true };
  }
  try {
    const res = await fetch(
      `${opts.siteUrl.replace(/\/+$/, "")}/api/v1/daily?date=${date}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const diffs = comparePackage(content, { issue: body.issue, items: body.items });
    if (diffs.length) throw new Error(`不一致：${diffs.join("；")}`);
    run.stage("verify-http", "ok", { base: opts.siteUrl });
    opts.progress(`HTTP-VERIFIED ${opts.siteUrl}/api/v1/daily?date=${date} 与内容一致`);
    return null;
  } catch (e) {
    run.stage("verify-http", "failed", { base: opts.siteUrl }, e.message);
    opts.progress(`FAIL 网站 API 核验失败（${opts.siteUrl}）：${e.message}`);
    return { error: `网站 API 核验失败（${opts.siteUrl}）：${e.message}` };
  }
}
