import { describe, expect, test } from "bun:test";
import { IncrementalParser } from "../../node_modules/@humanspeak/svelte-markdown/dist/index.js";
import {
  assistantMarkdownOptions,
  codeFileLinkLabel,
} from "@solus/workspace-ui/components/conversation/lib/assistant-markdown";

describe("assistant markdown", () => {
  test("keeps parser hooks disabled so append-only streams can use the tail window", () => {
    const parser = new IncrementalParser(assistantMarkdownOptions);
    const initialSource = "# Stable heading\n\nChanging tail";
    parser.update(initialSource);

    const internals = parser as unknown as {
      tailWindowDisabled: boolean;
      getTailWindowBoundary: () => {
        prefixCount: number;
        reparseOffset: number;
      };
      canUseTailWindow: (
        source: string,
        boundary: { prefixCount: number; reparseOffset: number },
      ) => boolean;
    };
    const boundary = internals.getTailWindowBoundary();

    expect(internals.tailWindowDisabled).toBeFalse();
    expect(boundary.reparseOffset).toBeGreaterThan(0);
    expect(boundary.reparseOffset).toBeLessThan(initialSource.length);
    expect(
      internals.canUseTailWindow(`${initialSource} grows`, boundary),
    ).toBeTrue();
  });

  test("keeps unmatched HTML distinguishable from matched HTML for literal fallback rendering", () => {
    const unmatched = new IncrementalParser(assistantMarkdownOptions).update(
      "<button> ?",
    ).tokens;
    const matched = new IncrementalParser(assistantMarkdownOptions).update(
      "<button>ok</button>",
    ).tokens;

    const unmatchedInline = unmatched[0] as {
      tokens: Array<{ type: string; raw: string; tag?: string }>;
    };
    const matchedInline = matched[0] as {
      tokens: Array<{
        type: string;
        raw: string;
        tag?: string;
        tokens?: Array<{ text?: string }>;
      }>;
    };

    expect(unmatchedInline.tokens[0]).toMatchObject({
      type: "html",
      raw: "<button>",
    });
    expect(unmatchedInline.tokens[0].tag).toBeUndefined();
    expect(matchedInline.tokens[0]).toMatchObject({
      type: "html",
      raw: "<button>",
      tag: "button",
    });
    expect(matchedInline.tokens[0].tokens?.[0]?.text).toBe("ok");
  });

  test("flattens a code-formatted file-link label so it cannot create a nested file chip", () => {
    expect(codeFileLinkLabel("`client-core/ws-transport.ts:232`", 232)).toBe(
      "client-core/ws-transport.ts",
    );
    expect(codeFileLinkLabel("plain label", 232)).toBeNull();
  });
});
