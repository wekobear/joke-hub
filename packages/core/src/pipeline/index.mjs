// 流水线域入口：CLI（scripts/daily-pipeline.mjs、daily-selftest 等）与测试
// 只从这里 import；管理操作（认领/发布/审计写入）也只从这里暴露，web 侧
// 永远只 import @joke-hub/core/publication（只读）。
export {
  runPipeline, EXIT, parseReviewVerdict, comparePackage,
  thresholdVerdict, applySelectionThreshold,
  selectCollectedMaterials, parseAdaptOutput, buildDailyPackage,
} from "./pipeline.mjs";
export { parseJudgeOutput, collectedVerdict } from "../sources/judge.mjs";
export { collectAll, loadSources } from "../sources/collect.mjs";
export { readSource, fingerprint } from "../sources/readers.mjs";
export { sanitizeBody, prefilter, chineseRatio } from "../sources/sanitize.mjs";
export { extractQuotedCsvTexts } from "../sources/parse.mjs";
export { validateDailyPackage, assertTargetDate, dupeMaterial } from "./validate.mjs";
export {
  PUBLISH_NOT_BEFORE, DAILY_REQUIREMENT, DAILY_SOURCE, DAILY_CATEGORIES, LIMITS, SELECTION,
  DUPE_LOOKBACK_DAYS, DUPE_SIMILARITY_THRESHOLD,
  dailyRunsDir, pipelineLogFile, shanghaiNow, checkPublishGate,
  contentHashStable, canonicalJson, normalizeText, bigramSimilarity,
} from "./config.mjs";
export {
  runDir, newRunId, atomicWriteJson,
  RunRecord, acquireLock, releaseLock,
  loadLatestRun, loadValidatedPackage, saveValidatedPackage, saveRejectedPackage,
} from "./runs.mjs";
export { runClaudeText, extractJson, ClaudeCliError } from "./claude-cli.mjs";
export {
  buildProducePrompt, buildRevisePrompt, buildReviewPrompt,
  renderPrompt, promptText, promptVersion, policyVersion,
} from "./prompts.mjs";
