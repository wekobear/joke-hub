// 采集清洗与预过滤：入库前的统一净化 + 廉价硬过滤（不花钱就先挡掉明显不可用的）。

/** 正文净化：去 HTML 标签/实体、去 URL、压空白。 */
export function sanitizeBody(raw) {
  return String(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 中文占比（CJK 字符 / 非空白字符），用于 zh 信源语言过滤。 */
export function chineseRatio(text) {
  const s = String(text).replace(/\s/g, "");
  if (!s.length) return 0;
  const cjk = s.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk / s.length;
}

/**
 * 廉价预过滤（评审模型之前）：
 *   - 净化后长度 20–800（最终长度边界仍由每日校验器把关）；
 *   - zh 信源中文占比 ≥ 0.6；en 信源至少要有字母；
 *   - 不能是纯符号/纯数字。
 */
export function prefilter(item, lang) {
  const body = sanitizeBody(item.body ?? "");
  if (body.length < 20 || body.length > 800) return { ok: false, body, reason: "长度" };
  if (lang === "zh" && chineseRatio(body) < 0.6) return { ok: false, body, reason: "中文占比不足" };
  if (lang === "en" && !/[a-zA-Z]{3,}/.test(body)) return { ok: false, body, reason: "无有效字母文本" };
  if (!/[\u4e00-\u9fffa-zA-Z]{6,}/.test(body)) return { ok: false, body, reason: "纯符号/数字" };
  return { ok: true, body };
}
