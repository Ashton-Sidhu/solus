import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shortId } from "@solus/workspace-ui/components/insights/lib/format";

const turnDetailSource = readFileSync(
  join(import.meta.dir, "../../packages/workspace-ui/src/components/insights/TurnDetailPanel.svelte"),
  "utf8",
);
const readInsightsSource = (path: string): string =>
  readFileSync(join(import.meta.dir, "../../packages/workspace-ui/src/components/insights", path), "utf8");

describe("Insights identifier copy", () => {
  test("the turn panel header can copy the complete trace identifier", () => {
    expect(turnDetailSource).toContain(
      '<CopyButton text={traceId} title="Copy Insights ID" iconOnly />',
    );
  });

  test("a table row context menu copies its complete Insights identifier", () => {
    const menu = readInsightsSource("data-table/DataTableContextMenu.svelte");
    expect(menu).toContain("Copy Insights ID");
    expect(menu).toContain("copy(insightsId, 'Insights ID')");
    expect(readInsightsSource("TurnList.svelte")).toContain("insightsId={menu.row.traceId}");
    expect(readInsightsSource("EventList.svelte")).toContain("insightsId={menu.row.traceId}");
  });

  test("the open-insight rail reuses the table context menu", () => {
    const rail = readInsightsSource("InsightsRail.svelte");
    expect(rail).toContain('import DataTableContextMenu from "./data-table/DataTableContextMenu.svelte"');
    expect(rail).toContain("oncontextmenu={(event) => openRowMenu(event, item)}");
    expect(rail).toContain("insightsId={menu.item.traceId}");
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
