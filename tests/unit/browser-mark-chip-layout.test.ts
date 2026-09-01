import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The chip row's rules live entirely in markup, so they are asserted against
 * the source. Each one is a rule the spec states and that nothing else can
 * fail on: a scroller hides an attachment the user is about to send, an inline
 * chip gets typed around, and a fixed text size stops scaling between a laptop
 * and a desktop display.
 */
const root = join(import.meta.dir, "../../packages/workspace-ui/src/components");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the composer chip row", () => {
  const source = read("input/AttachmentChips.svelte");

  it("wraps rather than scrolls", () => {
    expect(source).toContain("flex flex-wrap gap-1.5");
    expect(source).not.toContain("overflow-x-auto");
  });

  it("renders one chip per mark, and no second chip beside them", () => {
    // The page and viewport ride each mark chip. A separate frame chip would be
    // a second thing to read for a fact the chip already states.
    expect(source).toContain("{#each marks as mark");
    expect(source).not.toContain("FrameChip");
  });

  it("removes one mark rather than the whole annotation", () => {
    expect(source).toContain("onRemoveMark(a.id, mark.id)");
  });
});

describe("the mark chip", () => {
  const source = read("browser/MarkChip.svelte");

  it("takes the shelf rung, a step under the composer's own chrome", () => {
    // 12px on a desktop display, 10px on a laptop. A chip label the same size
    // as the controls around it competes with them; a hard-coded rung freezes
    // it at one display size.
    expect(source).toContain("text-chrome-shelf");
    expect(source).not.toContain("text-workspace-chrome");
    expect(source).not.toMatch(/class="[^"]*\btext-(xs|sm|base)\b/);
  });

  it("prints the pin it was given", () => {
    expect(source).toContain("{chip.pin}");
    expect(source).not.toContain("index + 1");
  });

  it("is only clickable in the sent form, and only while its page is open", () => {
    expect(source).toContain("{#if sent && onOpen}");
  });

  it("lets the path give before the host", () => {
    // A chip that truncates its host cannot tell two worktrees apart.
    const host = source.indexOf("{chip.host}");
    const path = source.indexOf("{chip.path}");
    expect(source.slice(host - 40, host)).toContain("shrink-0");
    expect(source.slice(path - 40, path)).toContain("truncate");
  });
});

describe("what a sent message keeps of its attachments", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts"),
    "utf8",
  );

  it("carries the whole attachment into the transcript", () => {
    // Flattening to a few fields dropped `designData`, `id`, `path` and
    // `hostPath` while keeping `dataUrl` — the only large member — so a sent
    // browser annotation rendered with no marks, no element and no capture.
    const send = source.indexOf("const attachments = input.attachments.length > 0");
    expect(send).toBeGreaterThan(-1);
    const mapping = source.slice(send, send + 220);
    expect(mapping).toContain("...attachment");
    expect(mapping).not.toContain("name: attachment.name");
  });
});

describe("the sent chip row", () => {
  const source = read("conversation/UserMessageBubble.svelte");

  it("sits below the prose, outside the bubble", () => {
    const bubble = source.indexOf("{#if text}");
    expect(source.indexOf("{#if sentMarks.length > 0}")).toBeGreaterThan(bubble);
  });

  it("is the whole annotation — there is no card above it", () => {
    // A card restating the mark count, the note and the element is a second,
    // larger reading of what the chips already say.
    expect(source).not.toContain("UserAnnotationCard");
  });

  it("collapses past three chips instead of running the row long", () => {
    expect(source).toContain("sentMarks.length > 3 && !marksExpanded");
    expect(source).toContain("+{hiddenMarkCount} mark");
  });
});
