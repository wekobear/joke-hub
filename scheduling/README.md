# 每日 09:00 定时发布（示例，默认未安装）

claude CLI 运行在本地机器：调度器在本地触发 `npm run daily`，生产准备可早于
09:00（内容先行就绪），**发布由两级时间门禁把关**——本机预检 + 云端 RPC 用服务
器时钟复核固定 09:00（Asia/Shanghai）。早于 09:00 触发不会发布：内容保存为
`prepared`，命令以退出码 3 结束，等待下一轮重试在门禁后发布。

## 行为约定

| 场景 | 行为 |
| --- | --- |
| 09:00 前触发 | 生产+校验+审稿完成，写库被门禁挡下（exit 3），下一轮重试发布 |
| 09:00 后重跑 | 复用已就绪成品（重新校验+审稿绑定 hash），发布并核验 |
| 当天已发布 | 幂等：只做读回核验，不重复生产、不重写（exit 0） |
| 已发布但内容 hash 不同 | 拒绝覆盖（exit 4），保护已发布内容 |
| 校验/审稿拒绝 | 最多一次修稿，仍失败 exit 2，绝不入库；失败材料在 data/daily-runs/<date>/ |
| 错过 09:00 | 默认运行只处理当天，**不会自动补发**；需显式 `npm run daily -- --date <目标日期>` 补发（迟到补发被门禁允许，按日期幂等不重复） |
| 并发重复触发 | 本机 SQLite 事务锁 + 云端日期认领，后到者直接退出 |

## 方式一：launchd（macOS）

`scheduling/com.jokehub.daily.plist` 是**通用模板**（默认未安装）：仓库内的
提交版本只含占位路径，安装前需按本机实际环境修改——仓库路径、node/npm/claude
所在目录（launchd 不加载用户 shell 配置，PATH 要在 ProgramArguments 里显式
export）、触发时刻（07:25/08:25 生产准备 + 09:00/09:37/10:07 门禁后发布重试）。
`JOKE_SITE_URL` 留空即可由 `npm run daily` 自动读取仓库 `.env`。

**含私有路径的本机安装副本请放在仓库外**（如 `/tmp` 或直接填好后再拷贝到
`~/Library/LaunchAgents`），不要提交回公开仓库。安装时先查重再加载：

```bash
launchctl list | grep jokehub        # 应无输出，避免重复任务
cp <本机填好的>.plist ~/Library/LaunchAgents/com.jokehub.daily.plist
launchctl load ~/Library/LaunchAgents/com.jokehub.daily.plist
```

注意：launchd 按系统本地时区解释 StartCalendarInterval。若机器不是上海时区，
把 Hour 改成对应的 UTC 偏移小时；即使设错，发布门禁也会拦住提前发布（代价是
浪费一轮生产，内容会幂等复用，不会重复）。

## 方式二：cron（Linux/macOS）

```cron
# 生产准备提前跑（07:25 与 08:25 各一次，未到门禁的运行幂等，成品就绪等发布）
25 7,8 * * * cd /path/to/joke-hub && npm run daily >> scheduling/cron.log 2>&1
# 门禁后发布窗口（09:00 起每 15 分钟一次到 10:45，已发布的运行直接幂等核验）
0,15,30,45 9-10 * * * cd /path/to/joke-hub && npm run daily >> scheduling/cron.log 2>&1
```

首个门禁后触发定在 09:00；发布本身有生产/校验/审稿/写库耗时，是分钟级完成，
不要预期 09:00:00 秒级准点，后续每 15 分钟的重试兜底。

## 环境变量

调度环境需要能读到 `.env`（SUPABASE_URL / SUPABASE_ANON_KEY /
SUPABASE_SERVICE_KEY）；`claude` CLI 必须在 PATH 中。

**`JOKE_SITE_URL` 需指向发布核验探测的网站 HTTP 地址**：`npm run daily` 会自动
读取仓库 `.env`，本地站点场景写进 `.env` 即可（未设置时默认
`http://127.0.0.1:4310`，本地跑着站点时可直接成功）；launchd/cron 环境若不便
依赖 `.env`，也可写进 plist 的 EnvironmentVariables，例如：

```xml
<key>EnvironmentVariables</key>
<dict><key>JOKE_SITE_URL</key><string>https://your-site.example.com</string></dict>
```

远程站点必须设为实际地址，默认 localhost 才会失败。

未配置云时流程落到本地 SQLite（门禁只有本机预检，无服务器时钟复核），可用于
无云验证但不算端到端。
