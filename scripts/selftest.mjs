// store 层自测：npm run selftest（使用独立测试库，不碰 data/jokes.sqlite）
import fs from "node:fs";
import assert from "node:assert";
import { openDb, importContent, getNotice, getJoke, randomShortJoke, queryJokes } from "../lib/store.mjs";

const TEST_DB = "data/selftest.sqlite";
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });

const seed = JSON.parse(fs.readFileSync("content/seed.json", "utf8"));
let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// 1. 空库 → 种子导入（带 notice）
const d1 = openDb(TEST_DB, "content/seed.json");
ok("空库种子导入 + notice 来自 metadata", () => {
  assert.ok(getNotice(d1).includes("试刊"));
  assert.ok(getJoke(d1, "umbrella"));
});

// 2. 用户通过 content:import 修改同 id 内容后，重启（重新 openDb+seed）不得覆盖
importContent(d1, {
  schemaVersion: 1,
  notice: "用户新 notice",
  issues: [],
  jokes: [
    {
      id: "umbrella",
      title: "被改过的雨伞",
      body: "用户改写后的正文",
      category: "生活",
      format: "短笑话",
      date: "2026-09-12",
      featured: false,
      source: { label: "用户导入", url: null, kind: "original" },
    },
  ],
});
const d2 = openDb(TEST_DB, "content/seed.json"); // 模拟进程重启
ok("重启后种子不覆盖显式导入的同 id 内容", () => {
  assert.equal(getJoke(d2, "umbrella").title, "被改过的雨伞");
  assert.equal(getNotice(d2), "用户新 notice");
});

// 3. 校验拒绝项
const baseJoke = {
  id: "x1",
  title: "t",
  body: "b",
  category: "生活",
  format: "短笑话",
  date: "2026-09-13",
  featured: false,
  source: { label: "s", url: null, kind: "original" },
};
function bad(name, content) {
  ok(`拒绝 ${name}`, () => {
    assert.throws(() => importContent(d2, content));
  });
}
bad("无效日历日期 2026-02-30", {
  schemaVersion: 1,
  notice: "n",
  issues: [{ date: "2026-02-30", title: "t", description: "d", jokeIds: ["x1"] }],
  jokes: [baseJoke],
});
bad("重复期次日期", {
  schemaVersion: 1,
  notice: "n",
  issues: [
    { date: "2026-09-13", title: "t", description: "d", jokeIds: ["x1"] },
    { date: "2026-09-13", title: "t2", description: "d", jokeIds: ["x1"] },
  ],
  jokes: [baseJoke],
});
bad("一期重复 jokeIds", {
  schemaVersion: 1,
  notice: "n",
  issues: [{ date: "2026-09-13", title: "t", description: "d", jokeIds: ["x1", "x1"] }],
  jokes: [baseJoke],
});
bad("id 含路径分隔符", {
  schemaVersion: 1,
  notice: "n",
  issues: [],
  jokes: [{ ...baseJoke, id: "../evil" }],
});
bad("source.url 非 http/https", {
  schemaVersion: 1,
  notice: "n",
  issues: [],
  jokes: [{ ...baseJoke, source: { label: "s", url: "javascript:alert(1)", kind: "original" } }],
});
bad("期次引用包外笑话", {
  schemaVersion: 1,
  notice: "n",
  issues: [{ date: "2026-09-13", title: "t", description: "d", jokeIds: ["ghost"] }],
  jokes: [baseJoke],
});

// 4. 随机只返回短笑话
ok("randomShortJoke 只返回短笑话", () => {
  for (let i = 0; i < 20; i++) {
    const j = randomShortJoke(d2);
    assert.ok(!j || j.format === "短笑话");
    if (j) return;
  }
  throw new Error("库里应有短笑话");
});

// 5. 分页 offset 溢出保护
ok("page 溢出返回空页而非报错", () => {
  const r = queryJokes(d2, { page: 999999999, limit: 50 });
  assert.deepEqual(r.items, []);
});

fs.rmSync(TEST_DB, { force: true });
fs.rmSync(`${TEST_DB}-wal`, { force: true });
fs.rmSync(`${TEST_DB}-shm`, { force: true });
console.log(`\n${pass} 项通过`);
