import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EDGE_COLOR,
  toFlowEdges,
} from "../../src/renderer/components/diagram/lib/flow-builders";

describe("diagram flow edge styling", () => {
  test("keeps async meaning in the dash style without forcing ambient motion", () => {
    const [edge] = toFlowEdges(
      [{ id: "events", source: "api", target: "bus", kind: "async" }],
      {},
    );

    expect(edge.className).toBe("edge--async");
    expect(edge.animated).toBe(false);
    expect(edge.markerEnd?.color).toBe(DEFAULT_EDGE_COLOR);
  });

  test("preserves explicitly authored edge motion", () => {
    const [edge] = toFlowEdges(
      [
        {
          id: "live-events",
          source: "api",
          target: "bus",
          kind: "async",
          animated: true,
        },
      ],
      {},
    );

    expect(edge.animated).toBe(true);
  });
});
