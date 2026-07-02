import * as fs from "fs";
import * as path from "path";
export default function ({ path: p, recursive }: { path: string; recursive?: boolean }) {
  if (!recursive) return fs.readdirSync(p);
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(p, "");
  return out;
}
