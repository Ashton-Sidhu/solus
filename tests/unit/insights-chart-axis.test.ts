import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TIME_AXIS_INSET_PX,
  TIME_AXIS_LABEL_GAP_PX,
} from "@solus/workspace-ui/components/insights/lib/chart-axis";

const ROOT = join(import.meta.dir, "../..");

function source(file: string): string {
  return readFileSync(
    join(ROOT, "src/renderer/components/insights", file),
    "utf8",
  );
}

describe("Insights time-axis spacing", () => {
  test("keeps time labels clear of marks and inside the chart", () => {
    expect(TIME_AXIS_LABEL_GAP_PX).toBeGreaterThanOrEqual(8);
    expect(TIME_AXIS_INSET_PX).toBeGreaterThan(TIME_AXIS_LABEL_GAP_PX);
  });

  test("applies the shared gap to every bottom time axis", () => {
    for (const file of [
      "VolumeChart.svelte",
      "SessionContextChart.svelte",
      "ResultTrendChart.svelte",
    ]) {
      const component = source(file);
      expect(component).toContain(
        "tickLabelProps={{ dy: TIME_AXIS_LABEL_GAP_PX }}",
      );
      expect(component).toContain("TIME_AXIS_INSET_PX");
    }
  });

  test("applies the shared gap above the waterfall marks", () => {
    const component = source("TraceWaterfall.svelte");
    expect(component).toContain(
      "tickLabelProps={{ dy: -TIME_AXIS_LABEL_GAP_PX }}",
    );
    expect(component).toContain("const AXIS_HEIGHT = TIME_AXIS_INSET_PX");
  });
});
