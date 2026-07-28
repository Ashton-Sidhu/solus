import { describe, expect, test } from "bun:test";
import {
  extractTrackedReferences,
  parseReferenceTokens,
  serializeReferenceToken,
  type ReferenceToken,
} from "../../src/renderer/components/editor/reference-tokens";

const tokens: ReferenceToken[] = [
  { kind: "file", path: "src/renderer/App.svelte", name: "App.svelte" },
  {
    kind: "plan",
    planId: "session-1:tool-1",
    sessionId: "session-1",
    planToolUseId: "tool-1",
    title: "Fix [the] input",
    status: "accepted",
  },
  {
    kind: "work",
    workId: "work-1",
    title: "Editor [notes]",
    type: "doc",
  },
  { kind: "pr", number: 42, title: "Make typing fast [again]" },
  { kind: "slash", command: "/review" },
  {
    kind: "session",
    sessionId: "session-2",
    provider: "codex",
    title: "Editor research",
    cwd: "/Users/sidhu/project with spaces",
  },
];

describe("reference token markdown", () => {
  test("round-trips every composer reference through one canonical format", () => {
    const source = tokens.map(serializeReferenceToken).join(" ");
    const parsed = parseReferenceTokens(source, {
      slashCommands: ["/review"],
    }).map(({ token }) => token);

    expect(parsed).toEqual(tokens);
  });

  test("only decorates slash commands from the current command set", () => {
    const source = "/review /not-installed";
    expect(
      parseReferenceTokens(source, { slashCommands: ["/review"] }).map(
        ({ token }) => token,
      ),
    ).toEqual([{ kind: "slash", command: "/review" }]);
  });

  test("does not mistake email addresses or ordinary links for chips", () => {
    const source =
      "sidhu@example.com [docs](https://example.com) @src/main/index.ts";
    expect(parseReferenceTokens(source)).toEqual([
      {
        from: source.indexOf("@src"),
        to: source.length,
        token: {
          kind: "file",
          path: "src/main/index.ts",
          name: "index.ts",
        },
      },
    ]);
  });

  test("ignores malformed Solus links instead of hiding editable source", () => {
    const malformed =
      "[Broken](plan://ref?planId=missing-required-fields) " +
      "[PR](pr://ref?number=not-a-number)";
    expect(parseReferenceTokens(malformed)).toEqual([]);
  });

  test("extracts tracked refs once per durable id", () => {
    const plan = tokens[1];
    const work = tokens[2];
    const session = tokens[5];
    const source = [
      serializeReferenceToken(plan),
      serializeReferenceToken(plan),
      serializeReferenceToken(work),
      serializeReferenceToken(session),
    ].join("\n");

    expect(extractTrackedReferences(source)).toEqual({
      planRefs: [
        {
          planId: "session-1:tool-1",
          sessionId: "session-1",
          planToolUseId: "tool-1",
          title: "Fix [the] input",
          status: "accepted",
        },
      ],
      workRefs: [
        {
          workId: "work-1",
          title: "Editor [notes]",
          type: "doc",
        },
      ],
      sessionRefs: [
        {
          sessionId: "session-2",
          provider: "codex",
          title: "Editor research",
          cwd: "/Users/sidhu/project with spaces",
        },
      ],
    });
  });
});
