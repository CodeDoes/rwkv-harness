import * as fs from "fs";
import * as path from "path";
export default function ({ path: p, content }: { path: string; content: string }) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
  const size = fs.statSync(p).size;
  return { success: true, path: p, bytes: size, status: "written" };
}
