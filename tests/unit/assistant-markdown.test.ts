import { describe, expect, test } from "bun:test";
import { codeFileLinkLabel } from "@solus/workspace-ui/components/conversation/lib/assistant-markdown";

describe("assistant markdown", () => {
  test("flattens a code-formatted file-link label so it cannot create a nested file chip", () => {
    expect(codeFileLinkLabel("`client-core/ws-transport.ts:232`", 232)).toBe(
      "client-core/ws-transport.ts",
    );
    expect(codeFileLinkLabel("plain label", 232)).toBeNull();
  });
});
