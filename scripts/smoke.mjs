// 冒烟测试：npm run smoke（需服务已启动在 127.0.0.1:4310）
const base = "http://127.0.0.1:4310";
const checks = [
  ["/api/v1/daily", 200],
  ["/api/v1/jokes?q=%E9%9D%A2%E8%AF%95", 200],
  ["/api/v1/jokes/ex001", 200],
  ["/api/v1/jokes?page=0", 400],
  ["/api/v1/jokes?limit=99", 400],
  ["/api/v1/daily?date=2026-9-9", 400],
  ["/api/v1/daily?date=2020-01-01", 404],
  ["/api/v1/jokes/nonexistent", 404],
  ["/api/v1/random", 200],
  ["/", 200],
  ["/library", 200],
  ["/jokes/ex001", 200],
  ["/skill", 200],
  ["/downloads/jokes-v0.5.0.zip", 200],
];
let fail = 0;
for (const [path, expect] of checks) {
  const res = await fetch(base + path);
  const ok = res.status === expect;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${path} -> ${res.status} (期望 ${expect})`);
}
const daily = await (await fetch(base + "/api/v1/daily")).json();
console.log("daily.issue =", JSON.stringify(daily.issue));
console.log("daily.items =", daily.items.length);
process.exit(fail ? 1 : 0);
