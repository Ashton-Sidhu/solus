import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shortId } from "../../src/renderer/components/insights/lib/format";

const turnDetailSource = readFileSync(
  join(import.meta.dir, "../../src/renderer/components/insights/TurnDetailPanel.svelte"),
  "utf8",
);

describe("Insights identifier copy", () => {
  test("the turn panel header can copy the complete trace identifier", () => {
    expect(turnDetailSource).toContain(
      '<CopyButton text={traceId} title="Copy Insights ID" iconOnly />',
    );
  });

  test("the breadcrumb shortens the trace identifier but keeps the whole one reachable", () => {
    // The header prints a recognisable head; the full value stays on the title
    // attribute and the copy control, so nothing about the turn is lost.
    expect(shortId("69ce76d6-ed56-4f24-aaa4-99f652e9b95d")).toBe("69ce76d6");
    expect(shortId("abc123")).toBe("abc123");
    expect(shortId(null)).toBe("—");
    expect(turnDetailSource).toContain("title={traceId}>{shortId(traceId)}");
  });

  test("every crumb in the turn header returns to the listing", () => {
    // Full screen covers the page's own breadcrumb, so this band must carry the
    // way back — otherwise the only exit is closing the turn from an icon.
    const header = turnDetailSource.slice(
      turnDetailSource.indexOf("<header"),
      turnDetailSource.indexOf("</header>"),
    );
    expect(header).toContain(">Insights</button>");
    expect(header).toContain(">{listLabel}</button>");
    expect(header.match(/class=\{CRUMB_BUTTON\} onclick=\{onClose\}/g)).toHaveLength(2);
  });
});
