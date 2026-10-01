# 笑话网站（joke-hub）重构方案

> 版本：v2.0（2026-10-01，已按 CodeX 评审意见修订；v1.0 评审结论"需修订后实施"，
> 本版逐条落实评审意见，修订记录见 §10）
> 参考项目：[AIHOT](https://github.com/wekobear/AIHOT)（行业热点网站框架）
> 本文档是重构的产品与工程方案，作为实施依据。
>
> **实施状态（2026-10-01）：P0–P7 全部完成并通过验收。**
> 全量回归：typecheck ✓ / selftest 10 项 ✓ / daily-selftest 72 项（基线 52）✓ /
> hash-stable 6 项 ✓ / selection-eval ✓ / issue:check ✓ / api-test 26 项（基线 18）✓ /
> build ✓ / smoke 18 项 ✓。CodeX 评审两轮：第一轮 16 条意见全部落实，
> 复核确认后仅剩 2 条文档级修正（§5 RLS 写法、verdict 可空），已按处方修复后实施。

---

## 1. 背景与目标

joke-hub 当前（v0.3.0）是一个已上线的中文每日笑话站：Next.js 16 单应用 + 双模存储（本地 SQLite / Supabase REST）+ 本地 claude CLI 每日流水线，部署在 Netlify，站点地址 https://wekobear-joke-hub.netlify.app 。

AIHOT 是一个成熟的开源内容站框架（三进程 monorepo、配置驱动的行业包、单一公开读取层、append-only 判断账本、回执与预算熔断、多信源采集聚簇）。本次重构的目标是：**把 AIHOT 的工程设计理念移植进 joke-hub，让"改定位、改标准、改提示词"不再需要改代码，让每一次内容判断可追溯，让所有公开出口读到同一份内容**——同时保持现有部署模型（Netlify + Supabase + 本地调度）与公开 API 合同完全不变。

明确的非目标（见 §9）:不迁移技术栈为三进程常驻服务。

## 2. AIHOT 设计理念提炼

研究 AIHOT 仓库后，可移植的理念归纳为九条：

| # | 理念 | AIHOT 中的形态 | 对 joke-hub 的意义 |
|---|---|---|---|
| 1 | **行业配置包** | `industry/` 独立 workspace：站名、分类词表、信源、提示词、门槛、功能开关全在配置里，"换行业不改代码" | 站名文案、分类白名单、每日配比、审稿门槛、幽默规则提示词目前硬编码在 `lib/daily/config.mjs`、`lib/daily/prompts.mjs`、`lib/daily/validate.mjs`（LIMITS）与 `app/` 页面里 |
| 2 | **提示词外置 + 内容哈希版本** | `industry/prompts/*.md`，`{{var}}` 模板；`promptVersion = sha256 前 10 位`，写入每条判断 | 提示词在 `.mjs` 字符串里，改一个字无法追溯是哪版提示词产出的内容 |
| 3 | **单一公开读取层** | 网页/RSS/API/MCP/llms.txt/sitemap 全部读 `packages/backend/src/publication/`，可见性规则施加一次 | web 读 `lib/db.ts`，流水线读自己的 `backend.readIssue`，是两套并行读取路径；将来加 RSS 还会出现第三套 |
| 4 | **判断 append-only 可追溯** | `analyses` 表：每次判断一行，带模型、prompt_version、回执 id、全量输出 | 审稿分数与理由只落在本地 `data/daily-runs/` 的 JSON 里，不进数据库，换机器即丢失 |
| 5 | **量化门槛，不信模型自判** | 评分两次取和与门槛比较；`selection.ts` 是唯一决定"多少分入选"的地方 | 审稿 pass/fail 由审稿模型自己说了算（实测三项全 0 分 + pass=true 也放行），硬门槛缺失 |
| 6 | **给 Agent 用同一份内容** | RSS 四种、公开 API、MCP、`llms.txt`、sitemap | 只有 web 页面 + JSON API，无 RSS/llms.txt/sitemap |
| 7 | **功能开关化** | `features.ts` 一个布尔决定模块注册、导航入口、路由是否 404 | 无任何开关；新出口只能加代码 |
| 8 | **工作区分层** | npm workspaces：`apps/*` + `packages/*` + `industry`，互相以 `*` 引用，web 不依赖 backend | 单包，CLI、网站、校验器、提示词混在一个 `lib/` 里 |
| 9 | **给 Agent 的仓库说明** | 根目录 `AGENTS.md`：最常见的任务、要跑的检查、要守住的规则 | 无；未来任何 Agent 接手都要重新读全部代码 |

**研究了但不移植的三条**（避免机械照搬，取舍复核见 §9）：

- **三进程架构（api/worker/web + PostgreSQL + pg-boss）**：AIHOT 需要常驻队列服务多信源、多 worker 并发与付费 API 熔断；joke-hub 是 11 条/天、单机 launchd 调度、无并发 worker、无按次计费调用，没有常驻队列的实际需求。**保留 Next.js 单应用 + CLI 流水线形态。**
- **多信源外部采集**：**每日自动流水线仅生产原创内容**（这是 `validate.mjs` 的每日合同）；通用导入合同（`content-schema.ts` 允许 `adapted`/`example`）保持不变，不顺手收紧。
- **回执与预算熔断表（receipts/budgets）**：claude CLI 订阅制无按次计费，不建预算表；但**调用元数据不能丢**（当前 `claude-cli.mjs` 解析信封后丢弃）——耗时、退出状态、用量、会话标识记入 run 记录与判断事件（§6.5）。

## 3. 现状诊断

### 3.1 现有架构（保留的部分）

```
Next.js 16 App Router（app/ 页面 SSR + /api/v1 路由，HeroUI v3 + Tailwind 4）
  └─ lib/db.ts（server-only 门面：Netlify 临时路径回退 + 空库种子导入）
       ├─ lib/store.mjs（node:sqlite，本地模式）
       └─ lib/supabase-store.mjs（PostgREST，线上模式，RLS 只读 published）
scripts/daily-pipeline.mjs → lib/daily/pipeline.mjs
  生产（claude CLI）→ validate.mjs 硬校验 → 独立审稿 → claim → 门禁发布 → 读回核验
supabase/migrations/（joke_jokes / joke_issues / joke_issue_jokes / joke_metadata /
  joke_daily_runs + 认领/发布 RPC + 分类计数 RPC）
```

值得保留并在位的优秀设计（重构中不动）：幂等与覆盖保护、fail-closed 校验、09:00 双重门禁（本机预检 + 云端 RPC 服务器时钟复核）、发布以公开读回比对为准、单事务导入、双模存储同接口、RLS 匿名读取。

**初始化语义差异必须保留**（评审 #7）：web 门面为空库做种子导入、Netlify 临时路径回退（`lib/db.ts`）；流水线打开数据库**不做**种子导入（`pipeline.mjs openBackend`）。两者共享查询实现，但初始化入口分开，不合并成一个"同行为"的后端。

**已知的双端行为差异**（记录在案，本轮不统一，避免改变发布语义）：SQLite `dailyClaim` 允许对"已有期次、无运行记录"的日期认领；Supabase RPC 拒绝。SQLite 模式不支持 `--status`。

### 3.2 与理念的差距（本次要解决的）

| 差距 | 现状 | 后果 |
|---|---|---|
| 配置硬编码 | 分类/长度在 `config.mjs`+`validate.mjs`（LIMITS），站名文案在页面，FORMATS 在 `content-schema.ts` | 改分类或长度边界要动校验器代码 |
| 提示词硬编码 | `prompts.mjs` 模板字符串 | 无版本追溯；无法"改标准不动代码" |
| 读取路径双轨 | web 走 `lib/db.ts`，流水线核验走 `pipeline.mjs` 内联 `openBackend()` | 新增出口（RSS）要再抄一遍读取逻辑 |
| 判断不落库 | 审稿分数只在本地 run JSON | 云端无审计；Table Editor 看不到为什么某期被拒/通过 |
| 无量化门槛 | 审稿 pass 布尔自判（且全 0 分也可能 pass） | 标准不可配置、不可校准 |
| 出口单一 | 无 RSS/llms.txt/sitemap/robots | 订阅与搜索引擎发现靠人工 |
| 单包 | 无 workspaces 分层 | CLI 与网站耦合在同一依赖树 |
| 既有缺陷 | `pipeline.mjs verifyAndFinish` 中 `progress` 未定义（应为 `opts.progress`），发布后读回不一致路径会抛 ReferenceError 而非正常退出 | 评审已复现；P0 修复 |

## 4. 目标架构

### 4.1 目录结构（重构后）

```
joke-hub/
├── app/                        # Next.js 应用（仍在根，Netlify 配置不变）
│   ├── page.tsx / library / jokes/[id] / skill …
│   ├── api/v1/…                # 公开 API（合同不变），改读 publication 层
│   ├── feed.xml/route.ts       # 新增：日刊 RSS（features.rss 开关）
│   ├── llms.txt/route.ts       # 新增：给大模型的站点说明（features.llmsTxt）
│   ├── robots.txt/route.ts     # 新增（与 sitemap 同属 features.seo 开关）
│   └── sitemap.xml/route.ts    # 新增
├── components/                 # UI 组件（不动；首页去掉 10+1 硬截取，按期次实际内容渲染）
├── industry/                   # ★ 新 workspace：@joke-hub/industry（配置包）
│   ├── package.json            #   type: module；无依赖；exports 逐文件声明
│   ├── site.ts                 # 站名、副标题、介绍文案、站点 URL
│   ├── taxonomy.ts             # 分类白名单、格式枚举、每日配比、长度边界、
│   │                           # 原创来源固定声明（唯一出处，替代 DAILY_SOURCE）
│   ├── selection.ts            # 审稿量化门槛 + 查重参数（入选标准唯一出处）
│   └── features.ts             # 出口开关：rss / llmsTxt / seo（sitemap+robots 同开关）
│   └── prompts/
│       ├── produce.md          # {{date}} {{recentTitles}} {{requirement}}…
│       ├── revise.md           # {{previousJson}} {{reasons}} …
│       ├── review.md           # {{date}} {{packageJson}} {{recentTitles}} …
│       ├── rules-humor.md      # 共享幽默规则片段：{{> rules-humor}}（无下划线前缀）
│       └── rules-output.md     # 共享输出合同片段：{{> rules-output}}
├── packages/
│   └── core/                   # ★ 新 workspace：@joke-hub/core（领域层）
│       ├── package.json        #   type: module；依赖 @joke-hub/industry
│       └── src/
│           ├── content-schema.ts   #（自 lib/ 迁入，可擦除语法约束不变）
│           ├── store.mjs           # SQLite 存储适配器（自 lib/ 迁入 + analyses 表）
│           ├── supabase-store.mjs  # Supabase 存储适配器（自 lib/ 迁入 + saveAnalysis）
│           ├── publication/        # ★ 公开读取层（web/出口唯一数据源，只读）
│           ├── pipeline/           # 流水线域（自 lib/daily 迁入）：pipeline/validate/
│           │                       # runs/claude-cli + prompts 加载器；管理操作
│           │                       # （claim/publish/getDailyRun/saveAnalysis）只从这里暴露
│           └── outlets/            # 出口生成器：rss.mjs / llms.mjs / sitemap.mjs
├── lib/db.ts                   # 薄门面：显式 re-export publication 层（名称与形状不变）
├── scripts/                    # CLI 入口（路径改指 core 包，行为不变）
├── supabase/migrations/        # 新增一个向后兼容迁移（见 §5）
├── AGENTS.md                   # ★ 新增：给 Agent 的仓库说明（仿 AIHOT）
└── package.json                # 根：workspaces = [industry, packages/*]
```

### 4.2 依赖方向与边界（评审 #8 的落实）

```
app/（Next.js 页面 + /api/v1 + 出口路由）──只 import──→ @joke-hub/core/publication（只读）
scripts/（CLI）──────────────────────────→ @joke-hub/core/pipeline + publication
@joke-hub/core ──→ @joke-hub/industry（配置，纯数据无依赖）
```

- **publication 与 pipeline 是两个独立入口**，共享底层 store 适配器：
  - `core/publication`：仅匿名读取（listIssues/getIssue/getLatestIssueWithJokes/…），不初始化任何写凭据，**不含** claim/publish/saveAnalysis 等管理方法；
  - `core/pipeline`：流水线专用（含管理操作与写凭据），web 永不 import。
- 边界由模块结构保证，不是注释约定。
- `lib/db.ts` **显式逐个 re-export**（含类型），不用 `export *`；`lib/store.d.mts` 同步迁移为 core 的类型声明。

### 4.3 接口兼容承诺（评审 #3 的落实）

**现有函数名与返回形状一律不变**：

- `getIssue(date) → Issue | null`、`getLatestIssueWithJokes() → Issue | null`（保持现名现形状）；
- 新增 `getIssueWithItems(date) → { issue, items } | null` 供流水线读回核验与新出口使用；
- `app/` 现有页面与 `/api/v1/*` 路由的 import 与调用点不需要改名（仅 `lib/db.ts` 内部来源变化）。

## 5. 数据模型变更（唯一的新迁移）

`supabase/migrations/20261001120000_joke_analyses.sql`——**安全模型对齐现有 `joke_daily_runs` 的写法**（评审 #1）：

```sql
create table if not exists public.joke_analyses (
  event_id uuid primary key,            -- 客户端生成；唯一键幂等（重试不重复插入）
  run_date date not null,               -- 目标内容日期
  run_id text not null,                 -- 对应 data/daily-runs 的 runId
  stage text not null check (stage in ('review','review-rebind')),
  attempt integer not null default 1,   -- 第几次生产/修稿后的审稿
  outcome text not null check (outcome in ('pass','reject','error')),
                                        -- error = 审稿调用失败/输出不可解析
  verdict boolean,                      -- 审稿原始判定（含门槛前）；pass/reject 必填，
                                        -- error 时不存在原始判定、必须为 null（不虚构 false）
  scores jsonb,                         -- {originality,funniness,safety} 0-10；error 时可 null
  check ((outcome = 'error' and verdict is null)
      or (outcome in ('pass','reject') and verdict is not null)),
  reasons jsonb not null default '[]',
  threshold_verdict boolean,            -- 量化门槛复核结果（分数低于门槛即 false）；无分数时 null
  content_hash text,                    -- 能确定候选稿时必填（含被拒稿），无法确定才 null
  prompt_version text not null,         -- industry/prompts 渲染源集合的 sha256 前 10 位
  policy_version text not null,         -- prompt_version + selection/taxonomy 配置哈希
  model text,                           -- 调用元数据（claude CLI 会话标识或模型名）
  duration_ms integer,                  -- 审稿调用耗时
  usage jsonb,                          -- CLI 信封里可获得的用量（无则 null）
  raw_output jsonb,                     -- 审稿原始输出（追溯用）
  created_at timestamptz not null default now()
);
alter table public.joke_analyses enable row level security;
revoke all on public.joke_analyses from anon, authenticated;
-- GRANT 是追加权限：必须先显式撤销 service_role 对本表的一切权限，再仅授予
-- SELECT/INSERT，数据库层面才真正强制 append-only（UPDATE/DELETE/TRUNCATE 均被拒绝）
revoke all on public.joke_analyses from service_role;
grant select, insert on public.joke_analyses to service_role;
create index if not exists idx_joke_analyses_run_date on public.joke_analyses (run_date);
```

- 只增不改：现有表、RPC、RLS 全部不动。
- SQLite 端同步加表（字段一一对应，`event_id uuid primary key` 同样由客户端生成做幂等键）。
- **审计生命周期（评审 #2 的落实）**：每次审稿调用结束**立即独立追加**一条事件（pass/reject/error 都记）；发布事务只负责内容发布，二者不强绑同一事务。运行模式下审计写入失败 → 视为本轮失败，不进入发布；`--prepare` 模式不写库（by design），事件保存在本地 run 记录 JSON 中，该内容日后经运行模式发布时，发布前的 rebind 审稿事件必然落库（现有 rebind 逻辑保证）。
- 验收覆盖：可追加（INSERT 成功）；service_role 不可 UPDATE / DELETE / **TRUNCATE**；anon 不可读（并入 `supabase-verify` 断言）；`verdict` 的 null 语义受 CHECK 约束（error 必 null，pass/reject 必非 null）。

## 6. 模块设计

### 6.1 industry 配置包

**site.ts**——站点身份唯一出处（站名/文案/URL），页面标题、meta、RSS channel、llms.txt 全部引用，替换散落在 `app/layout.tsx` 等处的硬编码。

**taxonomy.ts**——吸收并成为唯一出处：
- `DAILY_CATEGORIES`（自 `config.mjs`）
- `FORMATS`（自 `content-schema.ts`——schema 文件改从这里取值，消除两处定义）
- `DAILY_REQUIREMENT`（配比）
- `LIMITS`（长度边界，自 `validate.mjs`——修正 v1.0 把出处写成 config.mjs 的错误）
- `DAILY_SOURCE` 原创来源固定声明（v1.0 的 `sources.json` **取消**——只有一个原创来源，建 JSON 会造成两份来源配置；声明就放 taxonomy.ts 一处）

**selection.ts**——量化门槛：

```ts
export const SELECTION = {
  // 审稿三档分数的入选下限（0-10）；任一低于下限即拒绝，与审稿 pass 双重约束
  // 注意：初值 7/7/9 是工程默认，未经样本校准；校准方法见 §6.1.1
  minScores: { originality: 7, funniness: 7, safety: 9 },
  dupeSimilarityThreshold: 0.55,   // 词面 bigram 相似度（能力边界见 §9-4）
  dupeLookbackDays: 14,
} as const;
```

**6.1.1 门槛校准（评审 #13 的落实）**：新增 `scripts/selection-eval.mjs`——对一小组人工标注样本（好稿/拒稿/边界稿各若干，存 `content/selection-samples.json`）回放门槛判定，报告误放/误拒；改 `minScores` 前必须跑。门槛与分类配置哈希并入 `policy_version`（见 §5）。

**features.ts**——三个独立开关（修正 v1.0 目录写四个、示例三个的不一致）：

```ts
export const FEATURES = {
  rss: true,      // /feed.xml
  llmsTxt: true,  // /llms.txt
  seo: true,      // /sitemap.xml + /robots.txt（两者一体）
} as const;
```

**配置生效范围（评审 #4 的落实，如实声明）**：

| 配置 | 消费者 | 本轮是否全链路生效 |
|---|---|---|
| 分类白名单 | 生产/修稿/审稿提示词、校验器、页面筛选 | ✅ |
| 长度边界、查重参数、门槛分数 | 校验器、流水线 | ✅ |
| 站名文案 | 页面 meta、RSS、llms.txt | ✅ |
| 短内容条数 `shortCount` | 提示词（{{requirement}} 注入）、校验器（s01..sNN 已参数化）、**页面** | ✅（页面改为按期次实际内容渲染，去掉 10 条硬截取） |
| 脱口秀条数 `talkCount` | —— | ❌ 固定为 1（`-talk` id 唯一性约束在本轮保持；放开需要改 id 合同） |
| `FORMATS` 增删 | —— | ❌ 本轮固定四种（format 是公开 API 字段，扩格式属 API 变更） |

启动时（CLI 与 build 前的 `check` 脚本）校验配置可实现性：`shortCount ∈ [1,99]`、`talkCount === 1`、`minCrosstalk + minSatire + minShortJokes ≤ shortCount` 等，不可实现直接报错。

### 6.2 提示词外置与版本哈希（core/pipeline/prompts）

- 模板语法沿用 AIHOT 两种：`{{name}}`（调用方传值，缺值报错）与 `{{> file}}`（原样内嵌共享片段，带环检测）。**片段名不带下划线前缀**（AIHOT 加载器的标识符语法要求，评审 #11）：`{{> rules-humor}}`、`{{> rules-output}}`。
- `promptVersion(name)` = sha256(该模板 + 全部被内嵌片段) 前 10 位；`policyVersion()` = sha256(promptVersion × 3 + selection + taxonomy) 前 10 位——**规则版本不只描述措辞，也描述门槛与词表**（评审 #13）。
- `build*Prompt` 保持函数签名不变，内部改走加载器；`claude-cli.mjs` 返回值从"仅正文"扩展为 `{ text, meta }`（meta 含耗时、退出状态、CLI 信封中的 usage/会话标识——不再丢弃，评审 §9-receipts 行）。
- 测试（并入 daily-selftest）：每个提示词文件可渲染、全部 `{{}}` 有值、共享片段**确实出现在渲染结果里**、所有模板 token 消失、缺文件/缺变量/循环引用各自报错。

### 6.3 publication 读取层 + pipeline 域（core 包内两个入口）

**`core/publication`（只读，web 与出口专用）**——函数名/形状与现状完全一致（§4.3），双模选择规则不变（配置了 Supabase 走 REST，否则 SQLite；配置不完整明确抛错）。web 初始化（种子导入 + Netlify 临时路径）留在 `lib/db.ts` 侧的装配逻辑，不进 publication。

**`core/pipeline`（流水线专用）**——`openBackend()`（无种子初始化，现状语义）、`getDailyRun/dailyClaim/dailyPublish/recentJokesForDupe/saveAnalysis`、流水线主体。读回核验改调 `publication.getIssueWithItems`，与网站同一读取实现。

### 6.4 出口生成器（core/outlets）

- `rss.mjs`：最新一期条目（标题 + 全文 + 详情页链接），channel 元数据来自 `SITE`。**ETag 对最终 XML 字节计算**（修正 v1.0 用期次内容指纹——不含站名/模板，改 SITE 后旧 ETag 不会失效的问题，评审 #14）；支持 `If-None-Match` 条件请求；XML 转义；条目 GUID 稳定（`tag:站点URL,joke-id`）；空站输出合法空 feed。
- `llms.mjs`：站点说明（站名、内容结构、API 端点、更新频率）。
- `sitemap.mjs`：首页、library、skill、全部期次页、全部笑话详情页。**分页遍历**（`queryJokes` 单页上限 50，循环取全量——修正 v1.0"一次调用导全部"的错误，评审 #14）。
- 四个 route handler 都先查 `features.ts`，关闭即 404（`notFound()` 在 Next 16 的点号路由下已验证可用，评审明确"已验证无问题"）。

### 6.5 流水线改造点（行为合同保持，修正 v1.0 的两处错误）

1. 常量改从 `industry` 读取（分类、配比、长度、门槛、查重参数）。
2. 提示词改经加载器；`policy_version` 随 run 记录与判断事件落库。
3. 每次审稿结束（pass/reject/error）立即 `saveAnalysis`；**量化门槛判定**：分数任一低于 `SELECTION.minScores` → 按 reject 处理（理由写明"分数低于门槛"），与审稿自判 pass 双重约束。
4. **历史核验修正（评审 #6）**：`idempotentVerifyPath` 从库内重建旧期时，**不再按当前每日规则重校验**（改配置会把完好历史判为损坏——评审已复现），只做 schema 形状校验 + hash 重算比对 + 公开读回比对；当前规则的完整校验只用于**新内容准入**。
5. P0 先修复 `verifyAndFinish` 的 `progress` 未定义 bug（`pipeline.mjs:589`，应为 `opts.progress`），并补一条"发布后读回不一致 → 正常 exit 4"的回归用例（现有 52 项自测未覆盖该路径）。

### 6.6 AGENTS.md 与运维说明（评审 §9-MCP 行的落实）

AGENTS.md 仿 AIHOT：仓库是什么、最常见的任务（改分类/配比/门槛/提示词 → 只动 `industry/`；改站名 → `industry/site.ts`）、必跑检查命令、要守住的规则（API 合同、迁移只增不改、门禁不可绕过、`.env` 不提交）。另附**运维路径说明**：隐藏内容 = status→draft；重新发布/修复内容 = 走每日 RPC 流水线（含审稿、门禁、hash 绑定）；Table Editor 定位为人工查看与应急工具，直接改表不执行审稿与门禁。

## 7. 实施阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 缺陷修复 | `progress` bug + 读回不一致回归用例 | `daily-selftest` 新用例绿 |
| P1 骨架 | workspaces + `industry/`、`packages/core/` 落位；文件迁移 + import 修正；`lib/db.ts` 显式薄门面（接口形状不变）；锁文件全量更新 | 既有全部命令绿；干净环境 `npm ci && npm run build` 通过（CI 同款） |
| P2 publication 先行 | publication/pipeline 两入口拆分（含 `getIssueWithItems`）；流水线核验改走 publication | api-test 18 项绿；daily-selftest 绿 |
| P3 配置包 | site/taxonomy/selection/features 落地；全链路消费者切换（提示词、校验器、页面渲染、meta）；配置可实现性启动校验 | 改 taxonomy 一个分类即可通过校验（测试验证）；页面不再硬截取 |
| P4 提示词 | 外置 `.md` + 加载器 + 双版本哈希 + 可渲染/防错测试 | `policy_version` 出现在 run 记录 |
| P5 判断落库 | 迁移 + `saveAnalysis`（双端）+ 门槛判定 + 调用元数据 + 历史核验修正 + selection-eval 脚本 | 审稿事件（含拒稿）落库；append-only 与 anon 不可见验证；历史核验不因配置变更误报 |
| P6 出口 | outlets + 四路由 + 开关 + api-test 扩展 | 四出口 curl 可用；开关关闭 404；ETag 条件请求生效 |
| P7 收尾 | AGENTS.md、README、全量回归 | §7.1 全绿 |

### 7.1 总验收标准

1. 既有合同不破坏：`/api/v1/*` 请求/响应形状不变；`content:import` 行为不变；`daily` 退出码语义不变；通用内容 schema（含 `adapted`/`example`）不变。
2. 兼容承诺：不修改/删除任何既有表、RPC、RLS；新迁移只增表；旧数据不动。
3. 全量回归（对齐 CI + 新增）：`typecheck`、`selftest`、`daily-selftest`（含新用例）、`hash-stable-regression`、`issue:check`、`api-test`（含出口）、`npm run build`。
4. 新能力可验证：RSS/llms.txt/sitemap/robots 可访问且受开关控制；审稿事件（含拒稿与失败）落库且 append-only；提示词与规则版本可追溯；改配置不改代码生效。

### 7.2 Netlify 构建验收（评审 #9 的落实，修正 v1.0"风险低"的轻率表述）

workspaces 化后 Netlify 构建的**明确验收条件**（不达成不上线）：

1. 根 `package-lock.json` 与 workspaces 同步更新（`npm install` 后提交，CI 的 `npm ci` 是照妖镜）；
2. `industry`、`core` 的 `package.json` 显式声明 `dependencies` 与逐文件 `exports`（含类型）；
3. 干净环境（删 `node_modules`）`npm ci && npm run build` 成功且产物含全部页面；
4. Netlify 云端构建一次验证（评审实测：本地 `netlify build --offline` 对 workspaces 根应用选择有障碍，但根目录构建本身是官方支持方式；以上云构建为准）；
5. 任一条件失败 → 回滚 P1 提交（单提交回滚点）。

### 7.3 Node 直跑约束（评审 #10 的落实）

- `industry`、`core` 两包 `type: module`，包内只用相对路径 + 显式扩展名导入，**不使用 `@/` 别名**（Node 不解析 tsconfig paths；真实落位 `node_modules` 的 TS 会被 Node 拒绝，workspace 符号链接 + 可擦除语法是经验证的可行路径）；
- `content-schema.ts` 可擦除语法约束在迁移后保持（无 enum/namespace/参数属性）；
- CI 增加一步 CLI 冒烟（`node scripts/selftest.mjs` 已覆盖：它经 CLI 路径 import core 包，等价于验证符号链接加载）。

## 8. 风险与回滚

- **Netlify 构建**：见 §7.2 的五条验收条件；失败回滚 P1。
- **Node 直跑 TS**：见 §7.3 约束；违反约束会在 CI 的 selftest/typecheck 立即暴露。
- **流水线行为回归**：`daily-selftest` 覆盖拒绝/门禁/幂等/覆盖/锁 + 新增读回不一致用例；P2–P6 每阶段跑一遍；生产发布前先 `--prepare` 干跑一期。
- **回滚策略**：每阶段一个提交；新迁移只有一张新表且无既有对象依赖，代码回退即可（表留存无害）。

## 9. 明确不做的事（本轮）

1. **三进程常驻架构**（api/worker/web + pg-boss + PostgreSQL 常驻）：没有常驻队列、多 worker 并发与按次计费熔断的实际需求（评审复核：维持不做，理由修正为"无实际需求"）。
2. **外部笑话信源采集**：每日自动流水线仅原创（每日合同的硬校验）；通用导入合同的 `adapted`/`example` 保持可用，不顺手收紧（评审复核：维持不做）。
3. **receipts/budgets 预算表**：无按次计费；但调用元数据（耗时/状态/用量）记入 run 与判断事件（评审复核：修正为"不建表但留元数据"）。
4. **embedding 语义查重与热度榜**：bigram 是**词面**相似度，不保证识别语义换皮——这是如实声明的能力边界（评审指出 v1.0"已覆盖"的说法不成立）；先用 `selection-eval` 的同梗改写样本评估漏检率，再决定是否引入语义方案。热度榜无信号来源（收藏在浏览器本地，属隐私设计）。
5. **MCP 与后台管理界面**：公开 API 已覆盖当前读取需求；运维走 §6.6 的路径说明（评审复核：维持不做，补运维说明）。

## 10. v2.0 修订记录（对 CodeX 评审的逐条响应）

| 评审意见 | 本版落实 |
|---|---|
| #1 新表 SQL 未启用 RLS/REVOKE、未强制 append-only | §5：对齐 `joke_daily_runs` 写法；GRANT 是追加权限 → 先 REVOKE service_role 再仅授 SELECT/INSERT；验收含 TRUNCATE 拒绝（复核轮补强） |
| #2 审计写入时机矛盾、拒稿不落库 | §5/§6.5：每次审稿立即独立追加（pass/reject/error 全记）；删"发布事务内写审计"；prepare 模式本地保存、发布时 rebind 事件必落库 |
| #3 publication 接口破坏现有调用方 | §4.3：函数名/形状不变；新增 `getIssueWithItems`；显式 re-export 不用 `export *`；`.d.mts` 同步迁移 |
| #4 只迁配置做不到全链路生效 | §6.1 配置生效范围表：如实声明 talkCount/FORMATS 本轮固定；页面去硬截取；启动校验可实现性 |
| #5 判断表字段不足以追溯；verdict NOT NULL 与 error 冲突 | §5：event_id/attempt/outcome/threshold_verdict/policy_version/model/duration/usage/raw_output；幂等靠客户端 uuid；verdict 改可空 + CHECK 约束（error 必 null、pass/reject 必非 null）（复核轮补强） |
| #6 配置变更破坏旧期核验（已复现） | §6.5-4：历史核验只做 schema+hash+读回，不用当前每日规则 |
| #7 双端初始化与行为差异 | §3.1 明示差异并保留；publication 只共享查询，初始化分开 |
| #8 publication 混入管理方法 | §4.2：publication（只读）与 pipeline（管理）两个入口，结构保证边界 |
| #9 Netlify workspaces 风险 | §7.2 五条验收条件替代"风险低" |
| #10 Node 直跑 TS 约束 | §7.3：type:module、相对路径、无别名、可擦除语法 |
| #11 提示词片段下划线不被展开 | §6.2：`rules-humor`/`rules-output` 命名 + 渲染断言测试 |
| #12 verifyAndFinish progress 未定义（已复现） | §3.2/§6.5-5/§7-P0：P0 修复 + 回归用例 |
| #13 门槛无校准证据、规则版本不含配置 | §6.1.1 selection-eval；policy_version 并入配置哈希 |
| #14 ETag 覆盖面、sitemap 分页 | §6.4：XML 字节 ETag、条件请求、GUID、分页遍历 |
| #15 阶段倒置、sources.json 双份配置、开关口径不一 | §7 顺序（publication 先行）；sources.json 取消；features 归并为三开关 |
| §9 取舍复核 | §2/§9 逐条改写理由（三进程/采集/receipts/embedding/MCP） |
