// API 层自测：npm run api-test
// 使用独立测试库 data/selftest-api.sqlite，自行启动/关闭 next start，不碰 data/jokes.sqlite。
import fs from "node:fs";
import { spawn } from "node:child_process";
import assert from "node:assert";
import { openDb } from "../lib/store.mjs";

process.env.JOKES_DB_PATH = "data/selftest-api.sqlite";
const TEST_DB = process.env.JOKES_DB_PATH;
for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });

// CLI 同路径导入（等价于 content:import 后的状态）
openDb(TEST_DB, null);
const { spawnSync } = await import("node:child_process");
spawnSync("node", ["scripts/content-import.mjs", "content/seed.json"], {
  stdio: "inherit",
  env: process.env,
});

const server = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", "4319"], {
  stdio: "ignore",
  env: process.env,
});
const base = "http://127.0.0.1:4319";
let pass = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}`);
    process.exitCode = 1;
  }
}
async function get(path) {
  const res = await fetch(base + path);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

try {
  // 等服务就绪
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(base + "/");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const daily = await get("/api/v1/daily");
  ok("daily 200 且含 notice 相关期次", daily.status === 200 && daily.body.issue.date === "2026-09-13");
  ok("daily 短篇+长篇齐全", daily.body.items.length === 12 - 1); // 12 条笑话，存档期 1 条

  const shorts = await get("/api/v1/jokes?format=%E7%9F%AD%E7%AC%91%E8%AF%9D&limit=50");
  ok("format 筛选只出短笑话", shorts.body.items.every((j) => j.format === "短笑话"));

  const search = await get("/api/v1/jokes?q=" + encodeURIComponent("导航"));
  ok("全文搜索命中", search.body.total >= 1);

  ok("非法 page 400", (await get("/api/v1/jokes?page=0")).status === 400);
  ok("非法 limit 400", (await get("/api/v1/jokes?limit=99")).status === 400);
  ok("非法日期 400", (await get("/api/v1/daily?date=2026-02-30")).status === 400);
  ok("不存在期次 404", (await get("/api/v1/daily?date=2020-01-01")).status === 404);
  ok("不存在笑话 404", (await get("/api/v1/jokes/nope")).status === 404);
  ok("q 超长 400", (await get(`/api/v1/jokes?q=${"a".repeat(101)}`)).status === 400);

  const favEmpty = await get("/api/v1/jokes?favorites=");
  ok("favorites=空串 表示空集合", favEmpty.status === 200 && favEmpty.body.total === 0);
  const favHit = await get("/api/v1/jokes?favorites=umbrella");
  ok("favorites 指定 id 命中", favHit.body.total === 1);

  const rnd = await get("/api/v1/random");
  ok("random 只返回短笑话", rnd.body.item && rnd.body.item.format === "短笑话");

  const page = await get("/api/v1/jokes?page=1&limit=2");
  const page2 = await get("/api/v1/jokes?page=2&limit=2");
  ok("分页不重叠", page.body.items[0].id !== page2.body.items[0].id);

  // 页面可用
  for (const p of ["/", "/library", "/skill", "/jokes/umbrella"]) {
    const res = await fetch(base + p);
    ok(`页面 ${p} 200`, res.status === 200);
  }
} finally {
  server.kill();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
}
console.log(`\n${pass} 项通过`);
