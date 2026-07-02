interface TodoItem { text: string; done: boolean }

const store = new Map<string, TodoItem[]>()

function defaultList(): TodoItem[] {
  return ["Write plan", "Chapter 1 + character wiki", "Chapter 2 + location wiki", "Chapter 3 + faction wiki"].map(t => ({ text: t, done: false }))
}

function render(items: TodoItem[]): string {
  let nextFound = false
  return items.map(i => {
    if (!i.done && !nextFound) { nextFound = true; return `- [${i.done ? "x" : " "}] ${i.text} ← NEXT` }
    return `- [${i.done ? "x" : " "}] ${i.text}`
  }).join("\n")
}

function getOrCreate(): TodoItem[] {
  let list = store.get("default")
  if (!list) {
    list = defaultList()
    store.set("default", list)
  }
  return list
}

export default function ({ action, item }: {
  action?: string
  item?: string
}): unknown {
  const list = getOrCreate()
  if (!action || action === "list") {
    const done = list.filter(i => i.done).length
    return `(${done}/${list.length} complete)\n${render(list)}`
  }
  if (action === "check") {
    if (!item || !item.trim()) return `No item specified.\n${render(list)}`
    const found = list.find(i => i.text === item!.trim())
    if (!found) return `Item not found: "${item}".\n${render(list)}`
    found.done = true
    return `Updated:\n${render(list)}`
  }
  return `Unknown action: "${action}". Use: check or list.`
}
