# 多信源采集（v0.5.0）

> 本功能取代 REFACTOR-PLAN.md §9 第 2 条"不做外部笑话信源采集"的取舍——
> 应产品要求引入。配比目标：**8 采集改编 + 2 原创 + 1 原创脱口秀**；
> 采集不足时自动降级（原创补足），配比变化体现在运行记录里。

## 一、信源清单与验证状态（2026-10-01 实测）

| 信源 id | 内容 | 语言 | kind | 验证状态 |
|---|---|---|---|---|
| `bilibili-hot-comments` | B站热门视频高赞神评（两跳：popular → reply，实时中文） | zh | bilibili_comments | ✅ 实测可用（唯一实时中文源，满足时效性需求） |
| `hf-chinese-joke` | [HF 中文笑话语料](https://huggingface.co/datasets/notsobad9527/chinese-joke)（jokes.csv，7.1MB，糗百风格） | zh | csv_quote | ✅ 实测可用（静态中文语料补充） |
| `official-joke-api` | [Official Joke API](https://official-joke-api.appspot.com)（setup/punchline 两段式） | en | json_api | ✅ 实测可用 |
| `jokeapi-dev` | [JokeAPI v2](https://v2.jokeapi.dev)（带 nsfw/racist 黑名单过滤） | en | json_api | ✅ 实测可用。**域名必须是 `v2.jokeapi.dev`**（此前配置误写成 `v2.jokeapi.net`，实测不可达 HTTP 000；id 已随域名更正） |
| `taivop-stupidstuff` | [stupidstuff 笑话集](https://github.com/taivop/joke-dataset)（3773 条，经 jsDelivr CDN，本地缓存 7 天） | en | json_list | ✅ 实测可用（预过滤通过率约 55%，超长正文被过滤） |

**当日热点话题源（`topics` 数组，v0.5.2）**——供每日原创部分作时效性题材参考：

| 话题源 id | 内容 | 验证状态 |
|---|---|---|
| `baidu-hot` | 百度热搜（`top.baidu.com/api/board`） | ✅ 实测可用 |
| `toutiao-hot` | 今日头条热榜（`toutiao.com/hot-event/hot-board`） | ✅ 实测可用 |

话题在每日流水线生产原创部分**之前**抓取一次（跨源去重，取前 12 条注入 produce/revise
提示词）；尽力而为：话题源全部失败也不阻断发布，当期回到日常题材。已发布幂等路径与
成品复用路径不触发任何抓取。知乎热榜 / B站热搜也可用，需要时按同格式追加。

**调研过但不采用的**：

| 候选 | 原因 |
|---|---|
| 段子乐开放平台（MZCretin/duanzile-open-api） | 需微信小程序注册 project_token，非免注册 |
| 糗事百科全站存档（saveweb/qiushibaike-archive） | 1.3TB / 元数据 5.3GB，不适合轻量采集；可作离线语料选项 |
| api.vvhan.com、api.uomg.com、api.oioweb.cn 等国内免费 API | 本机网络不可达（时通时断），稳定性差 |
| 天聚数行 TianAPI 笑话接口 | 需注册 key（免费额度大，可作为未来扩展） |
| wocka.json / reddit_jokes.json（同仓库更大文件） | 68MB 太大；如需更多英文语料可加 sources.json 条目 |

英文信源的内容在成刊时由模型**本地化改编**为自然中文（文化梗转换，不逐字翻译），来源归属保留在条目的 `source` 字段（label + 原文链接，kind=`adapted`）。

## 二、架构（AIHOT 采集理念的移植）

```
industry/sources.json        信源注册表（sources + topics 两部分）
packages/core/src/sources/
  fetch.mjs                  抓取层：超时/重试/UA/Range；file:// 供测试注入
  parse.mjs                  CSV 引号字段提取（支持换行与 "" 转义、伪记录头不误认）+ JSON 取值
  readers.mjs                四种读取器：json_api / json_list(带缓存) / csv_quote(区间采样) /
                             bilibili_comments(热门视频高赞神评两跳)
  sanitize.mjs               清洗（去标签/URL）+ 预过滤（长度/语言占比，不花钱先挡）
  judge.mjs                  批量评审（本地 claude CLI）：fit/funniness/safety/category
  collect.mjs                编排：单源失败隔离 → 预过滤 → 指纹判重入库 → 评审
  topics.mjs                 当日热点话题：跨源去重，尽力而为（失败不阻断发布）
物料池（joke_materials 表）  candidate → selected(被某期占用) / skipped(不合格)
                             fingerprint = 归一化正文 sha256，跨信源精确判重
每日流水线                   话题抓取(1次) → 选取(分数达标+近14天词面查重+随机窗口) →
                             本地化改编 → 组装(采集 s01..sNN + 原创紧随 + 脱口秀压轴) →
                             校验 → 审稿 → 发布
```

关键语义：

- **单源失败隔离**：一个信源挂了只记录 FAIL，不中断采集（jokeapi-net 经常这样）。
- **指纹判重**：入库时跨信源精确去重；选取时再做近 14 天 bigram 词面查重
  （能力边界：语义级换皮不保证，见 selection.ts 注释）。
- **评审 fail-closed**：评审调用失败/输出不可解析 = 不更新判定（保持待评审），
  下次 `collect` 重试；已评审不达标 → skipped（带理由）。
- **降级**：可入选物料不足 8 条时，缺口由原创补足（`originalShortCount = 2 + 缺口`），
  校验器合同允许 adapted ∈ [0,8]，但要求原创短内容 ≥ 1（每日刊原创底线）。
- **占用（v0.5.1 强化，经 CodeX 评审）**：物料占用是**事务型**的——只接受
  "未占用"或"已属同期"（幂等重跑）的物料，任一条已被他期占用即整批失败；
  `materialIds` 随本地成品持久化，`prepare → run` 复用路径同样执行占用；
  认领失败自动释放本次占用（物料回到候选池）。修稿轮会排除上一轮物料重新选取。
  **复用成品重绑审稿被拒（v0.5.2 回归修复）**：成品立即失效（删除 package.json，
  下次运行重新生产——与进度提示字面一致），本次物料占用同步释放回候选池。
- **评审终态保护（v0.5.1）**：评审写入限定未评审状态（`judged=false`），
  迟到的并发评审结果不会把已占用物料改回 candidate。
- **抓取防护（v0.5.1）**：响应体 16MB 字节上限（流式读取，超限即断）；
  `file://` 测试通道必须显式设 `JOKE_COLLECT_ALLOW_FILE=1`，生产只允许 http(s)；
  CSV 解析为单遍状态机（连续空行无平方级耗时，引号内伪记录头不误认，
  片段残缺前缀按 CSV 语义吞并相邻记录、丢弃残缺）。
- 已知局限：若审稿因采集条目拒稿且修稿重选后仍失败，该轮物料在下一次运行
  仍可能入选（选取窗口带随机性缓解）。

## 三、使用

```bash
npm run collect                 # 采集一轮：抓取 → 清洗 → 判重入库 → 模型评审
npm run collect -- --source hf-chinese-joke   # 只采指定信源
npm run collect -- --no-judge   # 只采集不评审（下次 collect 会补评 pending）
npm run daily -- --prepare      # 端到端：选取 8 条 + 改编 + 原创生产 + 校验 + 审稿
```

上线云端需先在 Supabase SQL Editor 依次执行两个新迁移：

1. `supabase/migrations/20261001120000_joke_analyses.sql`（v0.4 判断账本，如未执行）
2. `supabase/migrations/20261002090000_joke_materials.sql`（v0.5 物料池）

## 四、如何新增信源

在 `industry/sources.json` 的 `sources` 数组加一条（改配置不改代码）：

```json
{
  "id": "my-source", "name": "信源名", "kind": "json_api|json_list|csv_quote|bilibili_comments",
  "lang": "zh|en", "enabled": true,
  "config": { "url": "…", "link": "条目归属链接", "maxTake": 5 }
}
```

- `json_api`：URL 返回 JSON 数组（或 `listPath` 指向数组路径）；英文两段式笑话用
  `combine: ["setup","punchline"]` + `titleFrom: "setup"`。
- `json_list`：静态 JSON 数组文件（GitHub 数据集走 `cdn.jsdelivr.net/gh/<repo>@<branch>/<path>`，
  国内可达性好），整份下载本地缓存 `cacheDays` 天后随机采样。
- `csv_quote`：大 CSV 按随机字节区间采样（`fileSize` 必填），提取第 3 列引号正文。
- `bilibili_comments`：`popularUrl`（热门视频列表）+ `replyUrl`（评论接口，`oid=` 结尾，
  流水线拼 aid）+ `videos`（取前几个视频）+ `minLikes`（高赞阈值）；条目 url 指向视频页。

话题源加在顶层 `topics` 数组：`{ "id", "name", "enabled", "config": { "url", "listPath", "textField" } }`。

注意：信源内容版权归原作者所有，本站以"改编 + 标注原文链接"的方式引用；
上线前请自行确认对应信源的转载政策。测试（daily-selftest）不访问任何外部
服务——读取器测试全部走 `file://` fixture 注入。

## 五、配置项

- 配比：`industry/taxonomy.ts` 的 `DAILY_REQUIREMENT`
  （`collectedShortCount + originalShortCount === shortCount` 自动校验）。
- 采集门槛：`industry/selection.ts` 的 `SELECTION.collected.minScores`
  （funniness/safety 下限 + fit 必须 true；改前跑 `npm run selection-eval`）。
- 提示词：`industry/prompts/judge-collected.md`（评审）与
  `adapt-collected.md`（本地化改编），版本哈希自动进入 `policy_version`。
