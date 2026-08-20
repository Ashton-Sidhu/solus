import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/components/ui/sonner/sonner.svelte"),
  "utf8",
)
const appSource = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/App.svelte"),
  "utf8",
)
const webToasterSource = readFileSync(
  join(import.meta.dir, "../../apps/client/src/components/WebToaster.svelte"),
  "utf8",
)

describe("toast layout", () => {
  test("uses a short default duration", () => {
    expect(appSource).toContain("duration={3000}")
  })

  test("keeps every toast surface clickable over draggable window chrome", () => {
    // WHY: Electron drag regions intercept pointer input. The toaster can sit
    // over a draggable header on any page, so every client entry point must use
    // the shared toaster whose complete subtree opts out of window dragging.
    expect(source).toContain('class="toaster group no-drag"')
    expect(appSource).toContain('import { Toaster } from "./components/ui/sonner/index.js"')
    expect(webToasterSource).toContain(
      'import { Toaster } from "@solus/workspace-ui/components/ui/sonner/index.js"',
    )
  })
})
