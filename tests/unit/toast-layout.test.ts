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

describe("toast layout", () => {
  test("uses a short default duration", () => {
    expect(appSource).toContain("duration={3000}")
  })

  test("does not show an unreliable close control", () => {
    // WHY: the close control cannot receive clicks reliably in the native Pill
    // window. Toast actions and automatic dismissal remain available.
    expect(source).not.toMatch(/^\s+closeButton\s*$/m)
    expect(source).not.toContain("[data-close-button]")
  })
})
