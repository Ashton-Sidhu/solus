import { isMermaidFence, mermaidRenderMode, parseFence } from "@solus/document-model/fences";

const FENCE_OPENING = /^[ ]{0,3}(?:`{3,}|~{3,})/;

/**
 * The sources of the ```mermaid fences in `markdown` that are closed and should
 * draw, by the rules desktop and web use (`@solus/document-model/fences`): a
 * fence still streaming in stays code, and ```mermaid source stays code.
 *
 * Enriched reports `isComplete` only with its streaming animation, which Solus
 * does not use, so the closing fence is found here. Each source is joined by a
 * NUL, so the value stays the same while other text streams in.
 */
export function closedMermaidSources(markdown: string): string {
  if (!markdown.includes("mermaid")) return "";
  const sources: string[] = [];
  const lines = markdown.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE_OPENING.test(line)) {
      const fence = parseFence(markdown.slice(offset));
      // An open fence takes the rest of the text.
      if (!fence) break;
      if (isMermaidFence(fence.info) && mermaidRenderMode(fence.info) === "diagram") {
        sources.push(withoutTrailingNewlines(fence.body));
      }
      const fenceLines = fence.raw.replace(/\n$/, "").split("\n").length;
      for (let skipped = 0; skipped < fenceLines; skipped += 1) {
        offset += lines[index + skipped]!.length + 1;
      }
      index += fenceLines - 1;
      continue;
    }
    offset += line.length + 1;
  }
  return sources.join("\0");
}

/** Whether Enriched's code block is one of `closedMermaidSources`. */
export function isClosedMermaidBlock(code: string, closedSources: string): boolean {
  return closedSources !== "" && closedSources.split("\0").includes(withoutTrailingNewlines(code));
}

function withoutTrailingNewlines(code: string): string {
  return code.replace(/\n+$/, "");
}
