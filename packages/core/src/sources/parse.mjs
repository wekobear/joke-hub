// 采集解析层：CSV 引号字段提取（HF 中文笑话语料格式）与 JSON 取值。

/** 单条正文的最大长度（防异常输入撑爆内存；正常笑话远小于此）。 */
export const MAX_FIELD_BYTES = 16 * 1024;

/** 记录头形态：行首 数字串,十六进制串,（其后紧跟引号正文）。 */
const HEAD_RE = /^[ \t]*(\d{2,}),([0-9a-f]{8,}),/i;

/**
 * 从 CSV 文本片段中提取全部"第三字段为双引号文本"的记录正文。
 * 目标格式（jokes.csv）：`<id>,<hash>,"<正文>","<标签>",<数字>,<数字>`
 *
 * 单遍状态机实现（不用全局正则回扫——评审 #8：连续空行有平方级耗时）：
 *   行首态：逐行检查记录头前缀（数字 + 逗号 + 十六进制 + 逗号），且下一字符是引号；
 *   字段态：扫描引号字段（"" 转义、可含换行），未闭合到片段末尾 = 残缺丢弃；
 *   引号内的伪记录头（正文里出现 换行+数字,hex,"）不会被误认——扫描器在字段态。
 * 片段首尾的残缺记录自然丢弃。
 */
export function extractQuotedCsvTexts(text) {
  const src = String(text);
  const out = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    // 行首态：在本行开头找记录头前缀（只看行首有限窗口，避免回扫）
    const m = HEAD_RE.exec(src.slice(i, i + 96));
    if (!m || src[i + m[0].length] !== '"') {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }

    // 字段态：扫描完整引号字段（"" 转义、可含换行）
    let k = i + m[0].length + 1;
    let buf = "";
    let closed = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '"') {
        if (src[k + 1] === '"') {
          buf += '"';
          k += 2;
          continue;
        }
        closed = true;
        k++;
        break;
      }
      buf += ch;
      k++;
      if (buf.length > MAX_FIELD_BYTES) break; // 异常超长按残缺丢弃
    }
    if (!closed || !buf.trim()) {
      i = k; // 残缺：从字段结束处继续找下一个记录头
      continue;
    }
    out.push(buf);
    // 跳过本行剩余部分（标签等后续字段）
    const nl = src.indexOf("\n", k);
    i = nl < 0 ? n : nl + 1;
  }
  return out;
}

/** 按点路径取值：get({a:{b:1}}, "a.b") → 1。路径不存在返回 undefined。 */
export function getPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .split(".")
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * 把一条原始记录映射为 { title, body }。
 * combine = 用换行拼接多个字段（英文 setup/punchline 两段式笑话）；
 * 否则 itemBody 指定正文字段，titleFrom/itemTitle 指定标题字段（可缺省）。
 */
export function mapItem(item, cfg) {
  let body;
  if (Array.isArray(cfg.combine)) {
    body = cfg.combine.map((k) => item?.[k]).filter((v) => typeof v === "string").join("\n");
  } else {
    const v = item?.[cfg.itemBody];
    body = typeof v === "string" ? v : "";
  }
  let title = null;
  const t = item?.[cfg.titleFrom] ?? item?.[cfg.itemTitle];
  if (typeof t === "string" && t.trim()) title = t.trim();
  return { title, body };
}
