// 首期内容检查：npm run issue:check
// 验证第一期 = 10 则短内容（非脱口秀）+ 1 则脱口秀，11 个 ID 无重复无遗漏。
import fs from "node:fs";
import assert from "node:assert";

const seed = JSON.parse(fs.readFileSync("content/seed.json", "utf8"));
const first = seed.issues[0];
const byId = new Map(seed.jokes.map((j) => [j.id, j]));

// ID 无重复、无遗漏（全部可解析）
assert.equal(new Set(first.jokeIds).size, first.jokeIds.length, "一期内 jokeIds 有重复");
for (const id of first.jokeIds) assert.ok(byId.has(id), `期次引用了不存在的笑话 ${id}`);

// 按首页同规则分区
const jokes = first.jokeIds.map((id) => byId.get(id));
const shorts = jokes.filter((j) => j.format !== "脱口秀").slice(0, 10);
const longs = jokes.filter((j) => j.format === "脱口秀").slice(0, 1);

assert.equal(shorts.length, 10, `短区应为 10 则，实际 ${shorts.length}`);
assert.equal(longs.length, 1, `长区应为 1 则脱口秀，实际 ${longs.length}`);
assert.equal(longs[0].format, "脱口秀");
assert.equal(shorts.length + longs.length, jokes.length, "分区遗漏了条目");

const mix = [...new Set(shorts.map((j) => j.format))].join(" + ");
console.log(`PASS 首期 ${first.date}：短区 10 则（${mix}）+ 脱口秀 1 则，共 ${jokes.length} 个 ID 无重复无遗漏`);
