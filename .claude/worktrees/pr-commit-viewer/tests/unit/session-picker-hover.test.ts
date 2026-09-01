/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../src/renderer/components/session/SessionPickerItem.svelte",
  ),
  "utf8",
);

describe("session picker pointer selection", () => {
  test("a virtualized row only reclaims selection after the pointer moves", () => {
    expect(source).toContain("onmousemove={onHover}");
    expect(source).not.toContain("onmouseenter={onHover}");
  });
});
