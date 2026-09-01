import { describe, expect, test } from "bun:test";

import { shortId } from "@solus/workspace-ui/components/insights/lib/format";

describe("Insights identifier copy", () => {
  test("the breadcrumb shortens the trace identifier but keeps the whole one reachable", () => {
    // The header prints a recognisable head; the full value stays on the title
    // attribute and the copy control, so nothing about the turn is lost.
    expect(shortId("69ce76d6-ed56-4f24-aaa4-99f652e9b95d")).toBe("69ce76d6");
    expect(shortId("abc123")).toBe("abc123");
    expect(shortId(null)).toBe("—");
  });
});
