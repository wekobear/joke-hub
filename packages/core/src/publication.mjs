// 统一公开读取层（仿 AIHOT publication/ 理念）：web 页面、公开 API 与所有
// 对外出口（RSS / llms.txt / sitemap）的唯一数据源。**只读**——认领、发布、
// 审计写入等管理操作在 core/pipeline，web 侧永不 import 那个入口。
//
// 双模自适应：配置了 Supabase（SUPABASE_URL + anon/publishable key）走 REST
// （RLS 限定只能读 published）；否则走调用方传入的 SQLite 句柄（惰性获取，
// 未访问数据不打开）。配置不完整会明确抛错，绝不静默回退（与 db.ts 现状一致）。
//
// 初始化语义由调用方决定：web 门面传"种子导入 + Netlify 临时路径"的句柄，
// 流水线传"无种子"的句柄——读取实现共享，初始化不共享。
import * as store from "./store.mjs";
import * as sb from "./supabase-store.mjs";

export { SupabaseConfigError } from "./supabase-store.mjs";

/**
 * 构造读取器。getDb 是惰性 SQLite 句柄获取函数；Supabase 模式下不会被调用。
 * 返回的每个方法与 lib/db.ts 现有函数同签名；getIssueWithItems 为新出口专用。
 */
export function publicationReader({ getDb }) {
  // 每次调用重新判定配置：与原 lib/db.ts 行为一致（运行中配置变化可被感知）
  const pick = () => {
    const cfg = sb.supabaseReadConfig();
    return { cfg, db: cfg ? null : getDb() };
  };

  const backend = () => (sb.supabaseReadConfig() ? "supabase" : "sqlite");

  const listIssues = async () => {
    const { cfg, db } = pick();
    return cfg ? sb.listIssues(cfg) : store.listIssues(db);
  };
  const getIssue = async (date) => {
    const { cfg, db } = pick();
    return cfg ? sb.getIssue(date, cfg) : store.getIssue(db, date);
  };
  const getLatestIssueWithJokes = async () => {
    const { cfg, db } = pick();
    return cfg ? sb.getLatestIssueWithJokes(cfg) : store.getLatestIssueWithJokes(db);
  };
  const getNotice = async () => {
    const { cfg, db } = pick();
    return cfg ? sb.getNotice(cfg) : store.getNotice(db);
  };
  const getJoke = async (id) => {
    const { cfg, db } = pick();
    return cfg ? sb.getJoke(id, cfg) : store.getJoke(db, id);
  };
  const getJokesByIds = async (ids) => {
    const { cfg, db } = pick();
    return cfg ? sb.getJokesByIds(ids, cfg) : store.getJokesByIds(db, ids);
  };
  /** 一期 + 全部条目（流水线读回核验与 RSS 出口用）。无该期返回 null。 */
  const getIssueWithItems = async (date) => {
    const issue = await getIssue(date);
    if (!issue) return null;
    return { issue, items: await getJokesByIds(issue.jokeIds) };
  };
  const randomShortJoke = async () => {
    const { cfg, db } = pick();
    return cfg ? sb.randomShortJoke(cfg) : store.randomShortJoke(db);
  };
  const queryJokes = async (q) => {
    const { cfg, db } = pick();
    return cfg ? sb.queryJokes(q, cfg) : store.queryJokes(db, q);
  };
  const listCategories = async () => {
    const { cfg, db } = pick();
    return cfg ? sb.listCategories(cfg) : store.listCategories(db);
  };

  return {
    backend,
    listIssues,
    getIssue,
    getLatestIssueWithJokes,
    getNotice,
    getJoke,
    getJokesByIds,
    getIssueWithItems,
    randomShortJoke,
    queryJokes,
    listCategories,
  };
}
