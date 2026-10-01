// 采集抓取层：超时、重试、UA、Range、**响应体字节上限**（评审 #7：超时只限时间
// 不限数据量，异常信源可用超大响应耗尽内存——这不是单源 catch 能隔离的）。
// file:// 协议仅供离线测试注入 fixture，必须显式设置 JOKE_COLLECT_ALLOW_FILE=1
// 才启用（生产运行不设该变量，杜绝从文件系统读任意路径）。
import fs from "node:fs";

/** 默认响应体上限（stupidstuff 2.6MB / wocka 7.7MB 都在限内；reddit 68MB 会被拒）。 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function fileAccessAllowed() {
  return process.env.JOKE_COLLECT_ALLOW_FILE === "1";
}

/** 流式读取并累计字节，超限立即中断（不等整个 body 下载完）。 */
async function readBodyWithLimit(res, maxBytes, url) {
  const reader = res.body?.getReader();
  if (!reader) {
    // 无 body 流（罕见）：退回 text()，但仍受 maxBytes 检查
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`响应体超过上限 ${maxBytes}B：${url}`);
    }
    return text;
  }
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`响应体超过上限 ${maxBytes}B（已收 ${received}B）：${url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchText(url, { timeoutMs = 15_000, retries = 2, range, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      if (url.startsWith("file://")) {
        if (!fileAccessAllowed()) {
          throw new Error("file:// 抓取未启用（仅测试环境设 JOKE_COLLECT_ALLOW_FILE=1）");
        }
        const buf = fs.readFileSync(new URL(url));
        if (buf.byteLength > maxBytes) {
          throw new Error(`fixture 超过上限 ${maxBytes}B：${url}`);
        }
        return buf.toString("utf8");
      }
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`仅允许 http(s) 与测试 file://：${url}`);
      }
      const headers = { "user-agent": "Mozilla/5.0 (Macintosh) joke-hub-collector/0.5" };
      if (range) headers.range = `bytes=${range.start}-${range.end}`;
      const res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 206 = Range 命中；200 = 服务端忽略 Range 返回全量（接受，但同样受字节上限约束）
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await readBodyWithLimit(res, maxBytes, url);
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) throw new Error(`抓取失败 ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}
