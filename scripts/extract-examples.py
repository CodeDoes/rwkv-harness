#!/usr/bin/env python3
"""Extract inline tool_call content from JSONL examples into standalone files."""
import json
import re
import sys
from pathlib import Path


def extract_story(jsonl_path: Path, story_dir: str) -> None:
    lines = jsonl_path.read_text().strip().split("\n")
    new_lines = []
    base_key = f"story-{story_dir}"

    for line in lines:
        entry = json.loads(line)
        if entry["type"] == "tool_call":
            tool = json.loads(entry["content"])
            args = tool.get("arguments", {})
            path_val = args.get("path", "")
            content_val = args.get("content", "")

            # If content is substantial and path is a .md file
            if content_val and path_val.endswith(".md") and not content_val.startswith("@"):
                # Strip workspace prefix (e.g., "workspace/shadow-realm/") for clean ref
                clean_path = re.sub(r"^workspace/[^/]+/", "", path_val)
                ref_path = f"./{base_key}/{clean_path}"
                abs_path = jsonl_path.parent / base_key / clean_path
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                abs_path.write_text(content_val)
                print(f"  wrote {abs_path.relative_to(jsonl_path.parent)}")

                # Update content to @reference
                tool["arguments"]["content"] = f"@{ref_path}"
                entry["content"] = json.dumps(tool, ensure_ascii=False)

        new_lines.append(json.dumps(entry, ensure_ascii=False))

    jsonl_path.write_text("\n".join(new_lines) + "\n")
    print(f"  updated {jsonl_path.name}")


def main():
    examples_dir = Path("src/agents/storyteller/examples")
    for f in sorted(examples_dir.glob("create_*.jsonl")):
        name = f.stem.replace("create_", "")
        print(f"\n=== {name} ===")
        extract_story(f, name)


if __name__ == "__main__":
    main()
