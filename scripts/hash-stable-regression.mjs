// contentHashStable 顺序语义回归（纯内存，无文件/网络/DB，可安全随时运行）：
//   node scripts/hash-stable-regression.mjs
// 断言：
//   1. jokes 数组合法乱序 → hash 不变（展示顺序由 issue.jokeIds 决定）
//   2. issue.jokeIds 重排 → hash 改变（展示顺序有语义）
//   3. issues 数组乱序 → hash 不变（按 date 规范排序）
//   4. 输入对象不被修改（复制后排序）
//   5. 键序不同 → hash 不变（canonicalJson 原有语义）

import assert from "node:assert";
import { contentHashStable } from "../lib/daily/config.mjs";

const jokes = (ids) => ids.map((id) => ({ id, text: `笑话正文 ${id}` }));
const issue = (date, jokeIds) => ({ date, title: "测试一期", description: "回归用描述", jokeIds });

const jids = ["j01", "j02", "j03"];
const base = () => ({
  schemaVersion: 1,
  issues: [issue("2026-09-15", [...jids])],
  jokes: jokes([...jids]),
});

const h = (c) => contentHashStable(c);

// 1. jokes 数组重排（jokeIds 展示顺序不变）→ hash 相同
const reorderedJokes = base();
reorderedJokes.jokes.reverse();
assert.notStrictEqual(JSON.stringify(reorderedJokes.jokes), JSON.stringify(base().jokes));
assert.strictEqual(h(reorderedJokes), h(base()), "jokes 数组重排不应改变 hash");

// 2. jokeIds 展示顺序重排 → hash 不同
const reorderedIds = base();
reorderedIds.issues[0].jokeIds.reverse();
assert.notStrictEqual(
  h(reorderedIds), h(base()),
  "jokeIds 展示顺序重排必须改变 hash",
);

// 3. issues 按 date 乱序 → hash 相同
const multiIssue = () => ({
  schemaVersion: 1,
  issues: [issue("2026-09-14", ["j01"]), issue("2026-09-15", ["j02"])],
  jokes: jokes(["j01", "j02"]),
});
const swappedIssues = multiIssue();
swappedIssues.issues.reverse();
assert.strictEqual(h(swappedIssues), h(multiIssue()), "issues 乱序不应改变 hash");

// 4. 不修改输入：hash 前后深比较
const input = base();
const snapshot = JSON.stringify(input);
h(input);
assert.strictEqual(JSON.stringify(input), snapshot, "contentHashStable 不得修改输入对象");

// 5. 同内容不同键序 → hash 相同
const keySwapped = {
  jokes: base().jokes.map((j) => ({ text: j.text, id: j.id })),
  issues: [{ jokeIds: [...jids], description: "回归用描述", title: "测试一期", date: "2026-09-15" }],
  schemaVersion: 1,
};
assert.strictEqual(h(keySwapped), h(base()), "键序不同不应改变 hash");

// 6. 内容实质变化（id 不同）→ hash 不同（排除误判恒等）
const different = base();
different.jokes[0].id = "j99";
assert.notStrictEqual(h(different), h(base()), "内容变化必须改变 hash");

console.log("hash-stable-regression: 全部 6 项断言通过");
