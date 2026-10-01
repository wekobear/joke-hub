// 本地 claude CLI 调用封装：生产与独立校验都通过真实进程调用完成。
// 失败（非零退出、超时、is_error、JSON 解析失败）一律向上抛错，绝不伪造成功。
//
// 安全约束：
//   - 用 --tools "" 从可用工具集中彻底移除全部工具（--allowedTools 只是自动批准
//     清单，不禁用工具），保证纯文本生成/审稿：不联网、不执行命令、不改文件。
//   - 嵌套运行（本进程本身在 Claude Code 会话内被调用）时，剥离 CLAUDECODE 等
//     嵌套标记环境变量，避免子 CLI 把父会话当上下文（2026-09-15 实测通过）。
//   - stdout 限量收集，超时 SIGTERM 后 5s SIGKILL 兜底并确认退出。

import { spawn } from "node:child_process";

export class ClaudeCliError extends Error {
  constructor(message, { stage, exitCode, stderr } = {}) {
    super(message);
    this.name = "ClaudeCliError";
    this.stage = stage;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const MAX_STDOUT = 4 * 1024 * 1024; // 4MB 足够内容包/审稿 JSON，防内存无限增长
const SIGKILL_GRACE_MS = 5000;

/** 子 CLI 运行环境：剥离父 Claude Code 会话留下的嵌套标记。 */
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE(_|$)/i.test(k) || k === "CLAUDECODE") delete env[k];
  }
  return env;
}

/**
 * 以 -p（print）模式运行 claude CLI 并解析 JSON 输出，返回模型正文。
 */
export function runClaudeText(prompt, { timeoutMs = 600_000, label = "claude" } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--output-format", "json", "--tools", ""],
      { stdio: ["ignore", "pipe", "pipe"], env: childEnv() },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; // 先落定，防 close 事件在 reject 前先把结果按成功处理
      child.kill("SIGTERM");
      // SIGKILL 兜底：子进程忽略 SIGTERM 时仍要终止，并确认退出
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, SIGKILL_GRACE_MS);
      child.once("close", () => clearTimeout(killTimer));
      reject(new ClaudeCliError(`${label} 超时（${timeoutMs}ms），已终止`, { stage: label }));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length > MAX_STDOUT) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch {}
        return;
      }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeCliError(`${label} 无法启动 claude CLI: ${e.message}`, { stage: label }));
    });
    child.on("close", (code) => {
      if (settled) {
        // 超时/超限路径已 reject，无需重复
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        reject(new ClaudeCliError(`${label} 输出超过 ${MAX_STDOUT} 字节上限，已中止`, { stage: label }));
        return;
      }
      if (code !== 0) {
        reject(new ClaudeCliError(
          `${label} 退出码 ${code}：${stderr.trim().slice(0, 500) || "(无 stderr)"}`,
          { stage: label, exitCode: code, stderr: stderr.slice(0, 2000) },
        ));
        return;
      }
      // --output-format json 的外层信封
      let envelope = null;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new ClaudeCliError(`${label} 输出不是 JSON 信封：${stdout.slice(0, 200)}`, { stage: label }));
        return;
      }
      if (envelope.is_error) {
        reject(new ClaudeCliError(`${label} CLI 报错：${envelope.result ?? "(无详情)"}`, { stage: label }));
        return;
      }
      // 调用元数据随正文一起返回（订阅制无按次账单，但耗时/用量/会话仍要可追溯）
      resolve({
        text: String(envelope.result ?? ""),
        meta: {
          durationMs: Date.now() - startedAt,
          model: typeof envelope.model === "string" ? envelope.model : null,
          sessionId: typeof envelope.session_id === "string" ? envelope.session_id : null,
          usage: envelope.usage && typeof envelope.usage === "object" ? envelope.usage : null,
        },
      });
    });
  });
}

/**
 * 从模型正文提取 JSON 对象：容忍 ```json 围栏与前后说明文字。
 * 提取失败抛 ClaudeCliError（fail-closed：绝不把解析失败当通过）。
 */
export function extractJson(text, { label = "claude" } = {}) {
  let t = String(text).trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  if (fence) t = fence[1].trim();

  // 1) 整体就是合法 JSON（最常见，且单元素数组不会被误切）
  try {
    return JSON.parse(t);
  } catch {}

  // 2) 前后有说明文字：按顶层结构（首个 [ 或 { 谁在前）取首尾切一版
  //    （评审/改编输出数组、其余输出对象；切错时再试另一种）
  const arrStart = t.indexOf("[");
  const objStart = t.indexOf("{");
  const tries = [];
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
    const e = t.lastIndexOf("]");
    if (e > arrStart) tries.push(t.slice(arrStart, e + 1));
    if (objStart >= 0) {
      const oe = t.lastIndexOf("}");
      if (oe > objStart) tries.push(t.slice(objStart, oe + 1));
    }
  } else if (objStart >= 0) {
    const oe = t.lastIndexOf("}");
    if (oe > objStart) tries.push(t.slice(objStart, oe + 1));
    if (arrStart >= 0) {
      const ae = t.lastIndexOf("]");
      if (ae > arrStart) tries.push(t.slice(arrStart, ae + 1));
    }
  }
  for (const c of tries) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new ClaudeCliError(`${label} 输出中找不到合法 JSON：${text.slice(0, 300)}`, { stage: label });
}
