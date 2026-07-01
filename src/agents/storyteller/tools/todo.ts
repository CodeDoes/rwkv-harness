interface TodoItem { text: string; done: boolean }

const store = new Map<string, TodoItem[]>()

function render(items: TodoItem[]): string {
  let nextFound = false
  return items.map(i => {
    if (!i.done && !nextFound) { nextFound = true; return `- [${i.done ? "x" : " "}] ${i.text} ← NEXT` }
    return `- [${i.done ? "x" : " "}] ${i.text}`
  }).join("\n")
}

export default function ({ action, item, items }: {
  action: string
  item?: string
  items?: string
}): unknown {
  const key = "default"

  switch (action) {
    case "create": {
      const list: TodoItem[] = (JSON.parse(items || "[]") as string[]).map(t => ({ text: t, done: false }))
      store.set(key, list)
      return `Checklist created:\n${render(list)}`
    }
    case "check": {
      const list = store.get(key)
      if (!list) return { error: "No checklist. Create one first with action='create'." }
      if (!item) return { error: "Missing 'item' parameter" }
      const found = list.find(i => i.text === item)
      if (!found) return { error: `Item not found: "${item}"` }
      found.done = true
      return `Updated:\n${render(list)}`
    }
    case "list": {
      const list = store.get(key)
      if (!list) return "No checklist yet."
      const done = list.filter(i => i.done).length
      return `(${done}/${list.length} complete)\n${render(list)}`
    }
    default:
      return { error: `Unknown action: "${action}". Use: create, check, list.` }
  }
}
