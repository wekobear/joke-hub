# 网络采集扩容设计与验收清单（v0.5.0）

> 状态（2026-10-01）：**本会话暂停实施**。另一并行 Codex 会话正在本仓库实现采集功能；
> 用户确认等其完成后再由本会话验收/完善。本文档前半为已确认的产品口径，后半为
> 恢复操作时的验收清单（含已通过一轮 CodeX 审核的加固点）。

## 一、已确认口径（用户拍板）

- **每期总量不变：10 短内容 + 1 脱口秀**（不是 20 短；早前 20 短方案作废）。
- 配比：**8 条网络采集 + 2 条原创**短内容；脱口秀仍 1 条原创。
- 方向：降低 AI 原创占比，以网络采集的优秀段子为主；采集要求「好笑」，并希望有
  **时效性**内容（实时/当天的新鲜段子或热点话题）。
- 公开合同、fail-closed、门禁、幂等、覆盖保护、判断账本等仓库红线不弱化（AGENTS.md）。

## 二、实测可用的信息源（2026-10-01 本机探测，供信源注册表参考）

| 源 | 类型 | 状态 | 用途 |
|---|---|---|---|
| `https://api.bilibili.com/x/web-interface/popular` + `/x/v2/reply` | JSON 两跳 | ✅ 200 | B站热门视频高赞神评（**实时中文段子**，注意 oid 用 aid） |
| `https://v2.jokeapi.dev/joke/Any?amount=10&blacklistFlags=nsfw,racist,sexist,explicit` | JSON | ✅ 200 | 英文 SFW 笑话（编译改编，注意域名是 **.dev**；并行实现误写成 .net） |
| `https://top.baidu.com/api/board?platform=wise&tab=realtime` | JSON | ✅ 200 | 百度热搜（时效话题） |
| `https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc` | JSON | ✅ 200 | 头条热榜（时效话题，字段 Title/Url） |
| `https://api.zhihu.com/topstory/hot-list?limit=10` | JSON | ✅ 200 | 知乎热榜（时效话题，target.title） |
| `https://api.bilibili.com/x/web-interface/search/square?limit=10` | JSON | ✅ 200 | B站热搜（时效话题，keyword） |
| `https://apis.tianapi.com/duanzi/index` | JSON+key | 需免费 key | 中文段子（天行数据，缺 key 跳过） |
| HuggingFace `notsobad9527/chinese-joke` CSV | 静态语料 | 可用 | 中文笑话兜底语料（无时效性，只宜做补充） |
| 微博 `weibo.com/ajax/side/hotSearch`、糗事百科、公共 rsshub.app、vvhan/uomg | — | ❌ 403/SSL | 不可用（自建 RSSHub 是解锁糗百/微博的路径） |

时效性落点（口径下）：8 条采集尽量含当天的 B站神评等实时源；2 条原创可结合热搜话题
（若并行实现未做话题机制，验收时作为增强项提出）。

## 三、恢复操作时的验收清单（等并行 Codex 完成后执行）

来源：本方案经 codex(gpt-6-astra) 审核 12 条意见（无 P0，7×P1，5×P2），以下按合同
优先级整理为对并行实现的验收点：

1. **fail-closed 不弱化**：采集不足时的「降级补原创」改变了每期配比合同——需确认
   运行记录如实反映降级、且降级只影响当期，不产生静默永久回退；话题/采集全失败时
   的退出码与调度重试兼容。
2. **幂等/覆盖/门禁/账本**：新链路不触碰 joke_analyses 的 CHECK 约束（stage 仅
   review/review-rebind）；采集失败记 run 阶段，不伪造审稿事件；已发布期幂等核验
   绝不触发采集；历史内容不重判语义保留。
3. **来源真实性**：采集条目 source 由程序从信源/物料映射生成（模型不得手写署名），
   label/url 与信源注册表白名单硬校验；物料指纹判重覆盖跨源与近期历史。
4. **审稿门槛**：混合包逐条判定（itemScores 或等价机制），任一条不达标整包拒绝；
   originality 对采集条目的语义（可收录价值 vs 原创度）在提示词与 selection 文档写清；
   门槛变更走 selection-eval 校准流程。
5. **成品失效既有 bug**：复用成品重绑审稿拒绝后，package.json 实际未失效，下一轮
   仍复用坏稿（现有代码进度提示与行为不符）——验收时一并修复并加回归用例。
6. **候选/物料快照**：按 runId 不可变保存，与成品绑定可追溯；修稿只复用原始池。
7. **policyVersion**：新增提示词（judge/adapt 等）与信源注册表计入规则版本哈希。
8. **域名与卫生**：`v2.jokeapi.net` 应为 `v2.jokeapi.dev`；仓库根的 `./undefined/`
   目录、`joke-readers-*` 残留需清理（不应在仓库根写测试产物）。
9. **测试**：daily-selftest 全部走注入替身（不碰网络、清空 Supabase 变量）；新增
   采集失败/降级/来源伪造/判重场景；selftest、selection-eval、issue:check、
   build+api-test 全绿。
10. **公开 API**：`source.kind` 若新增取值（collected 等）只增不改；UI 详情页 kind
    映射同步；README/AGENTS.md/llms.txt 描述与新配比一致；采集内容署名与版权说明补齐。

## 四、恢复操作流程

1. `git status` + 与并行实现作者（用户）确认其会话已结束；
2. 按第三节清单验收并行实现，跑全量命令（typecheck / selftest / daily-selftest /
   selection-eval / issue:check / build + api-test）；
3. 缺口按优先级修补（P1 先行），重大分歧（如降级语义）再与用户确认；
4. `npm run daily -- --prepare` 真跑验收后收尾文档（README/AGENTS/VERSION）。
