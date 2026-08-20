/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/session/SessionPickerItem.svelte",
  ),
  "utf8",
);

describe("session picker pointer selection", () => {
  test("a virtualized row only reclaims selection after the pointer moves", () => {
    expect(source).toContain("onmousemove={onHover}");
    expect(source).not.toContain("onmouseenter={onHover}");
  });
});

describe("session picker provider icon", () => {
  test("uses the OpenAI blossom for Codex sessions", () => {
    expect(source).toContain('import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte"');
    expect(source).toContain('<OpenAIBlossom size={14} fill="currentColor" />');
    expect(source).not.toContain("Bot as OpenAiLogoIcon");
  });
});
