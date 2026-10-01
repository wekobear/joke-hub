# 给 Agent 的说明

这是一个中文每日笑话站：本地 claude CLI 每天生产原创内容 → 程序化硬校验 + 独立审稿 → 原子认领 → 时间门禁发布 → 公开读取路径读回核验。网站（Next.js）部署在 Netlify，读取走 Supabase 或本地 SQLite；流水线在维护者本机由 launchd 调度。先读 README，再按任务读对应模块。

## 最常见的任务：改定位、改标准、改提示词

这些事**只改 `industry/` 配置包**，代码不用动（这是本仓库重构后的核心约定，源自 AIHOT 的行业包理念）：

| 要改什么 | 改哪里 |
|---|---|
| 站名、介绍文案、站点地址、首页每日一句 | `industry/site.ts` |
| 分类白名单、每日配比（8 采集 + 2 原创 + 1 脱口秀）、长度边界、发布门禁时间 | `industry/taxonomy.ts` |
| 审稿分数门槛（originality/funniness/safety 下限）、查重参数 | `industry/selection.ts` |
| 出口开关（RSS / llms.txt / sitemap+robots） | `industry/features.ts` |
| 生产/修稿/审稿/采集评审/本地化改编提示词、幽默规则 | `industry/prompts/*.md` |
| 采集信源与热点话题源（新增/停用一个信源/话题源） | `industry/sources.json`（sources + topics，格式见 docs/COLLECTION.md） |

注意的边界：

- `shortCount` 可在 3–99 调整，且必须满足 `collectedShortCount + originalShortCount === shortCount`；`talkCount` 固定为 1；`FORMATS` 固定四种（公开 API 字段）。配置可实现性在 import 时自动校验。
- 采集相关：测试不访问任何外部服务（读取器/话题测试走注入 fetcher 或 `file://` fixture）；物料池有 curation 状态流转（candidate/selected/skipped），与 append-only 的 `joke_analyses` 不同。当日热点话题是**尽力而为**增强：全部话题源失败不阻断发布（当期回到日常题材）；已发布幂等路径与成品复用路径不触发任何抓取。
- **改门槛前先跑 `npm run selection-eval`**：用 `content/selection-samples.json` 的标注样本回放，看误放/误拒；同时用真实审稿输出去补充样本。不要凭感觉改数字。
- 改提示词会自动换 `promptVersion`/`policyVersion`（内容哈希），新判断事件自动携带新版本——不需要手动维护版本号。

## 运行与检查

- Node.js 24（`node:sqlite` 与直接运行 TypeScript 都依赖它）。npm workspaces：`industry`、`packages/core`、根应用。
- 改完至少跑：

```bash
npm run typecheck
npm run selftest          # 存储层
npm run daily-selftest    # 流水线合同（依赖注入，不需要 claude CLI 与云凭据；含采集/物料/降级用例）
npm run selection-eval    # 门槛与标注样本一致
npm run issue:check
npm run build && npm run api-test   # 起真实 next start 的 API + 出口回归
```

- 流水线真跑（会调本地 claude CLI，发布受 09:00 门禁约束）：先 `npm run collect`
  充实物料池，再 `npm run daily -- --prepare` 干跑。


## 要守住的规则

- **公开 API 合同不破坏**：`/api/v1/*` 四个端点的请求/响应形状、错误码是对外合同；通用内容 schema（含 `adapted`/`example` 来源）保持可用，不要顺手收紧。
- **两个入口的边界**：web 与出口只 import `@joke-hub/core/publication`（只读）；管理操作（认领/发布/判断落库）只在 `@joke-hub/core/pipeline`，绝不进 web。
- **数据库迁移只增不改**：新迁移按编号加在 `supabase/migrations/` 末尾，只新增表/函数，不改不删既有对象；SQLite 端 schema（`packages/core/src/store.mjs` 的 SCHEMA_SQL）同步维护。
- **发布合同不可绕过**：时间门禁（09:00 Asia/Shanghai 双重校验）、幂等（同 hash 不重写）、覆盖保护（不同 hash 拒绝覆盖已发布内容）、fail-closed（校验/审稿失败绝不入库）都不许弱化；判断事件（pass/reject/error）每次审稿都要落库或进本地 run 记录。
- **历史内容不重判**：已发布期次的幂等核验只做形状 + hash + 读回比对，不按当前每日规则重校验——改配置不能把完好的历史内容判为损坏。
- **不要提交** `.env`、`data/`、密钥；测试不得访问任何外部服务（daily-selftest 会显式清空 Supabase 变量）。
- 提示词模板只有两种语法：`{{var}}`（缺值报错）与 `{{> file}}`（内嵌共享片段，文件名不带下划线前缀）。

## 运维路径（不要用错入口）

- 隐藏内容：Supabase Table Editor 把该行 `status` 改为 `draft`（对网站与 API 立即不可见）。
- 重新发布 / 修复内容：走每日流水线（`npm run daily`），它会执行审稿、门禁与 hash 绑定；直接改表不会执行这些约束。
- Table Editor 定位是人工查看与应急工具，不是发布通道。
