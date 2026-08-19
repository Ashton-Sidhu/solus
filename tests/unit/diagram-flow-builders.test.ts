import { describe, expect, test } from "bun:test";
import type { DiagramEdge } from "@solus/contracts/diagram-types";
import {
  DEFAULT_ARROW_COLOR,
  effectiveEdgeDash,
  toFlowEdges,
} from "@solus/workspace-ui/components/diagram/lib/flow-builders";

describe("diagram flow edge styling", () => {
  test("keeps async meaning in the dash style without forcing ambient motion", () => {
    const [edge] = toFlowEdges(
      [{ id: "events", source: "api", target: "bus", kind: "async" }],
      {},
    );

    expect(edge.className).toBe("edge--async");
    expect(edge.animated).toBe(false);
    expect(edge.markerEnd?.color).toBe(DEFAULT_ARROW_COLOR);
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

describe("diagram flow edge dash", () => {
  const dashOf = (edge: Partial<DiagramEdge>): string | undefined =>
    toFlowEdges([{ id: "e", source: "a", target: "b", ...edge }], {})[0].style;

  test("leaves the dash to the kind class when no override is set", () => {
    // Emitting nothing is what lets `.edge--async` keep governing the line —
    // an inline `stroke-dasharray` here would freeze every edge at one pattern.
    expect(dashOf({ kind: "async" })).toBeUndefined();
    expect(dashOf({ kind: "sync" })).toBeUndefined();
  });

  test("an explicit solid clears the dashing an async edge would inherit", () => {
    // The whole point of the property: inline style outranks `.edge--async`,
    // so `none` is what actually un-dashes the line.
    expect(dashOf({ kind: "async", dash: "solid" })).toBe(
      "stroke-dasharray:none",
    );
  });

  test("an explicit dashed matches the async CSS rule exactly", () => {
    // Same value as `.edge--async`, so switching an async edge to explicit
    // dashed is a no-op on screen rather than a visible jump.
    expect(dashOf({ kind: "sync", dash: "dashed" })).toBe(
      "stroke-dasharray:5 5",
    );
  });

  test("dotted asks for a round linecap, since the base path sets none", () => {
    // Without it the dots render as squares and read as a tight dash.
    expect(dashOf({ kind: "sync", dash: "dotted" })).toBe(
      "stroke-dasharray:0.1 4;stroke-linecap:round",
    );
  });

  test("dash rides alongside the other inline appearance overrides", () => {
    expect(dashOf({ color: "#f00", width: 3, dash: "dashed" })).toBe(
      "stroke:#f00;stroke-width:3px;stroke-dasharray:5 5",
    );
  });

  test("carries body and dash into edge data, so a save round-trips them", () => {
    const [edge] = toFlowEdges(
      [
        {
          id: "e",
          source: "a",
          target: "b",
          body: "Order events, at-least-once",
          dash: "dotted",
        },
      ],
      {},
    );

    expect(edge.data?.body).toBe("Order events, at-least-once");
    expect(edge.data?.dash).toBe("dotted");
  });
});

describe("effectiveEdgeDash", () => {
  test("derives from kind only when there is no override", () => {
    expect(effectiveEdgeDash("async", undefined)).toBe("dashed");
    expect(effectiveEdgeDash("sync", undefined)).toBe("solid");
    expect(effectiveEdgeDash("data", undefined)).toBe("solid");
    expect(effectiveEdgeDash(undefined, undefined)).toBe("solid");
  });

  test("an override wins over the kind default in both directions", () => {
    expect(effectiveEdgeDash("async", "solid")).toBe("solid");
    expect(effectiveEdgeDash("sync", "dashed")).toBe("dashed");
  });
});
