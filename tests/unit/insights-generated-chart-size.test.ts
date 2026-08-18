import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

function componentSource(file: string): string {
  return readFileSync(
    join(ROOT, "src/renderer/components/insights", file),
    "utf8",
  );
}

describe("Insights generated chart size", () => {
  test("compacts time-series answers on laptop-height viewports", () => {
    const component = componentSource("ResultTrendChart.svelte");

    expect(component).toContain(
      "h-56 w-full sm:h-48 sm:[@media(min-height:1000px)]:h-64",
    );
  });

  test("compacts ranking rows on laptops and restores them on tall displays", () => {
    const component = componentSource("ResultRankingChart.svelte");

    expect(component).toContain(
      "sm:min-h-8 sm:py-1 sm:[@media(min-height:1000px)]:min-h-10",
    );
    expect(component).toContain(
      "sm:h-5 sm:[@media(min-height:1000px)]:h-6",
    );
  });

  test("compacts the main and turn-detail bar graphs on laptops", () => {
    expect(componentSource("VolumeChart.svelte")).toContain(
      "sm:h-44 sm:[@media(min-height:1000px)]:h-52",
    );
    expect(componentSource("SessionContextChart.svelte")).toContain(
      "sm:h-[4.5rem] sm:[@media(min-height:1000px)]:h-[5.5rem]",
    );
  });
});
