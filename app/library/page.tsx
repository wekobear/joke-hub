import LibraryClient from "./LibraryClient";
import { listCategories } from "@/lib/db";

export const dynamic = "force-dynamic";

const FORMATS = ["短笑话", "相声", "讽刺对话", "脱口秀"];

export default async function LibraryPage() {
  const categories = (await listCategories()).map((c) => c.category);
  return <LibraryClient categories={categories} formats={FORMATS} />;
}
