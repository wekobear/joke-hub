// 内容导入脚本：npm run content:import -- path/to/issue.json
// SQL 与校验全部复用 lib/store.mjs + lib/content-schema.ts，与网站同一套实现。
import fs from "node:fs";
import { openDb, importContent, defaultDbPath } from "../lib/store.mjs";

const file = process.argv[2];
if (!file) {
  console.error("用法: npm run content:import -- path/to/issue.json");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));

// 注意：打开库时不开种子导入（seedPath 为 null），导入只写本包内容。
const d = openDb(defaultDbPath(), null);
try {
  importContent(d, raw);
  console.log(`导入完成：${file}`);
} catch (e) {
  console.error("导入失败（未写入）：", e.message);
  process.exit(1);
}
