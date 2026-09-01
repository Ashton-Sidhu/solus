import { describe, expect, test } from "bun:test";
import { Lexer, type Token } from "marked";
import { preserveUnmatchedHtml } from "../../src/renderer/components/conversation/lib/assistant-markdown";

describe("assistant markdown", () => {
  test("shows an inline unmatched HTML-looking tag as the literal text the assistant wrote", () => {
    const tokens = Lexer.lex("<button> ?");

    tokens.forEach(preserveUnmatchedHtml);

    const paragraph = tokens[0] as Token & { tokens: Token[] };
    expect(paragraph.tokens[0]).toMatchObject({
      type: "escape",
      raw: "<button>",
      text: "<button>",
    });
  });

  test("leaves matched HTML and ordinary markdown tokens unchanged", () => {
    const matchedHtml = {
      type: "html",
      raw: "<button>",
      tag: "button",
      tokens: [],
    } as Token;
    const text: Token = { type: "text", raw: "button", text: "button" };

    preserveUnmatchedHtml(matchedHtml);
    preserveUnmatchedHtml(text);

    expect(matchedHtml.type).toBe("html");
    expect(text.type).toBe("text");
  });
});
