// Adapted from T3 Code apps/mobile/src/lib/mermaidSvg.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, it } from "bun:test";
import { render } from "pele";

import {
  closedMermaidSources,
  isClosedMermaidBlock,
} from "../../apps/mobile/src/lib/mermaidFences";
import { mermaidSvgForNative, withDiagramBackground } from "../../apps/mobile/src/lib/mermaidSvg";

describe("mermaidSvgForNative", () => {
  it("turns Pele's CSS variables and styles into attributes react-native-svg draws", () => {
    const { svg } = render(
      'flowchart LR\n  A[Client] -->|ws| B(Server)\n  B --> C["var(--pele-fg)"]',
      { links: false, images: false },
    );

    const native = mermaidSvgForNative(svg, {
      "--pele-fg": "#111111",
      "--pele-line": "#222222",
      "--pele-font": "Helvetica",
    });

    // react-native-svg ignores both, so nothing may be left in them.
    expect(native).not.toMatch(/="[^"]*var\(|style=/);
    // A label that reads like a variable keeps its text.
    expect(native).toContain(">var(--pele-fg)<");
    expect(native).toMatch(/^<svg[^>]* fill="#111111"[^>]* font-family="Helvetica" font-size="16">/);
    expect(native).toContain('stroke="#222222"');
    // Colors the theme leaves out keep Pele's fallback, and the corner radius becomes geometry.
    expect(native).toContain('fill="#f3f3f3"');
    expect(native).toMatch(/<rect[^>]* rx="4"/);
  });

  it("fills the viewBox before anything else draws, so the full-screen image reads on any background", () => {
    const { svg } = render("flowchart LR\n  A --> B", { links: false, images: false });
    expect(withDiagramBackground(mermaidSvgForNative(svg, {}), "#fafafa")).toMatch(
      /^<svg[^>]*><rect x="0" y="0" width="\d+(\.\d+)?" height="\d+(\.\d+)?" fill="#fafafa"\/>/,
    );
  });
});

describe("closedMermaidSources", () => {
  it("draws a closed fence and leaves one still streaming in as code, as desktop and web do", () => {
    const streaming = "Intro\n\n```mermaid\nflowchart LR\n  A --> B\n";
    expect(closedMermaidSources(streaming)).toBe("");
    expect(isClosedMermaidBlock("flowchart LR\n  A --> B", closedMermaidSources(streaming))).toBe(false);

    const closed = `${streaming}\`\`\`\n\nAfter`;
    expect(isClosedMermaidBlock("flowchart LR\n  A --> B\n", closedMermaidSources(closed))).toBe(true);
  });

  it("keeps ```mermaid source as code and finds no fence inside another fence", () => {
    const markdown = [
      "```mermaid source",
      "flowchart LR",
      "```",
      "",
      "````markdown",
      "```mermaid",
      "graph TD",
      "```",
      "````",
      "",
      "```mermaid",
      "sequenceDiagram",
      "```",
    ].join("\n");
    const sources = closedMermaidSources(markdown);
    expect(isClosedMermaidBlock("flowchart LR", sources)).toBe(false);
    expect(isClosedMermaidBlock("graph TD", sources)).toBe(false);
    expect(isClosedMermaidBlock("sequenceDiagram", sources)).toBe(true);
  });

  it("stays the same value while text after the diagram streams in", () => {
    const head = "```mermaid\ngraph TD\n```\n\nMore";
    expect(closedMermaidSources(`${head} text`)).toBe(closedMermaidSources(head));
  });
});
