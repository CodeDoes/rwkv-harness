import * as fs from "fs";
export default function ({ path, content }: { path: string; content: string }) {
  fs.writeFileSync(path, content);
  const size = fs.statSync(path).size;
  return { path, bytes: size, status: "written" };
}
