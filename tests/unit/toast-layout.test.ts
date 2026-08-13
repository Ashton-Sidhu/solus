import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(
  join(import.meta.dir, "../../src/renderer/components/ui/sonner/sonner.svelte"),
  "utf8",
)

describe("toast close control", () => {
  test("keeps close icon pointer events on the button and provides a 40px hit area", () => {
    expect(source).toContain("[data-close-button] > svg)")
    expect(source).toContain("pointer-events: none")
    expect(source).toContain("[data-close-button]::before)")
    expect(source).toContain("width: 40px")
    expect(source).toContain("height: 40px")
  })
})
