输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 围栏。
- 输出必须是严格合法的 JSON：字符串值内部**一律用中文引号「」或""**，绝不能用未转义的英文双引号；换行写成 \n。
- JSON 结构（本期含 {{collectedCount}} 条采集改编内容，你只创作原创部分）：
{
  "issueTitle": "<期标题 2~30 字>",
  "issueDescription": "<期描述 4~60 字，一句话>",
  "originalShorts": [
    { "title": "...", "body": "...", "category": "...", "format": "短笑话|相声|讽刺对话" }
  ]（恰好 {{originalShortCount}} 条）,
  "talk": { "title": "...", "body": "...", "category": "...", "format": "脱口秀" }（恰好 1 条）
}
- originalShorts 与 talk 都是你的原创，不需要 id/date/source 字段（流水线会补）。
- category 从白名单选；format 用上面给定的取值，talk 固定为"脱口秀"。
