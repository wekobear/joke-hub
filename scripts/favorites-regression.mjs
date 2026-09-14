// favorites 解析回归检查：只测真实坏数据案例，不镜像实现
// 运行：node scripts/favorites-regression.mjs
import { parseFavs } from "../components/favorites.ts";

const cases = [
  // [名称, localStorage 原始值, 期望结果]
  ["null", null, []],
  ["空字符串", "", []],
  ["合法字符串数组", JSON.stringify(["a", "b"]), ["a", "b"]],
  ["对象", '{"a":1}', []],
  ["数字", "42", []],
  ["混合数组", JSON.stringify(["a", 1, null, "b", {}, true]), ["a", "b"]],
  ["非字符串数组", JSON.stringify([1, 2, 3]), []],
  ["非法 JSON", "{oops", []],
  ["含空串的有效数组", JSON.stringify(["a", "", "b"]), ["a", "b"]],
];

let failed = 0;
for (const [name, raw, expected] of cases) {
  const got = parseFavs(() => raw);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.error(`FAIL [${name}] 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`);
  } else {
    console.log(`ok  ${name}`);
  }
}

// localStorage.getItem 本身抛异常时不崩溃
try {
  parseFavs(() => {
    throw new Error("storage unavailable");
  });
  console.log("ok  storage 抛异常");
} catch {
  failed++;
  console.error("FAIL storage 抛异常时应返回空数组而非崩溃");
}

if (failed) {
  console.error(`${failed} 个用例失败`);
  process.exit(1);
}
console.log("全部通过");
