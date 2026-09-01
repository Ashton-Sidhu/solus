import { describe, expect, test } from "bun:test";
import type { DiagramDoc } from "@solus/contracts/diagram-types";
import { summarizeDiagram } from "@solus/contracts/diagram-types";

/** The one sentence describing a diagram's size — it reaches the ledger row,
 *  the transcript card and the Workspace peek through `workPreview`, so a
 *  change here changes every surface at once. */
describe("diagram summary", () => {
  test("counts nodes and connections, and says nothing about clusters when there are none", () => {
    const doc: DiagramDoc = {
      nodes: [{ id: "api", label: "API" }, { id: "bus", label: "Bus" }],
      edges: [{ id: "publishes", source: "api", target: "bus" }],
    };

    expect(summarizeDiagram(doc)).toBe("2 nodes · 1 connection");
  });

  test("counts a group as a cluster rather than as a node it contains", () => {
    // A group is the box drawn around nodes, not a node in its own right —
    // counting it as one overstates the diagram by every container it has.
    const doc: DiagramDoc = {
      nodes: [{ id: "backend", label: "Backend", group: true }, { id: "api", label: "API" }, { id: "bus", label: "Bus" }],
      edges: [{ id: "publishes", source: "api", target: "bus" }],
    };

    expect(summarizeDiagram(doc)).toBe("2 nodes · 1 connection · 1 cluster");
  });

  test("keeps every count singular or plural on its own", () => {
    const doc: DiagramDoc = {
      nodes: [{ id: "backend", label: "Backend", group: true }, { id: "web", label: "Web", group: true }, { id: "api", label: "API" }],
      edges: [],
    };

    expect(summarizeDiagram(doc)).toBe("1 node · 0 connections · 2 clusters");
  });
});
