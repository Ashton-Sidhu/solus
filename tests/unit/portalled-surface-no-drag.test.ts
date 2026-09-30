import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Electron hit-tests `-webkit-app-region` without z-index. A popup portalled to
 * the body that drops over the titlebar drag region loses its clicks to window
 * movement unless the popup itself opts out. Every shared portalled surface
 * must therefore carry `no-drag`, or compose `menu-surface`, which declares it.
 */
const root = join(import.meta.dir, "../..");
const css = readFileSync(join(root, "packages/workspace-ui/src/workspace.css"), "utf8");
const uiDir = join(root, "packages/workspace-ui/src/components/ui");

const PORTALLED_SURFACES = [
  "dropdown-menu/dropdown-menu-content.svelte",
  "dropdown-menu/dropdown-menu-sub-content.svelte",
  "context-menu/context-menu-content.svelte",
  "context-menu/context-menu-sub-content.svelte",
  "select/select-content.svelte",
  "popover/popover-content.svelte",
  "tooltip/tooltip-content.svelte",
  "bottom-sheet/bottom-sheet.svelte",
] as const;

describe("portalled surfaces over the Electron drag region", () => {
  test("menu-surface opts out of window drag", () => {
    const utility = css.match(/@utility menu-surface \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(utility).toContain("-webkit-app-region: no-drag;");
  });

  test("every shared portalled surface opts out of window drag", () => {
    for (const file of PORTALLED_SURFACES) {
      const source = readFileSync(join(uiDir, file), "utf8");
      expect(/\b(no-drag|menu-surface)\b/.test(source), file).toBe(true);
    }
  });
});
