import { describe, expect, it } from "bun:test";
import {
  browserMarkChips,
  middleEllipsis,
} from "../../packages/workspace-ui/src/lib/browser-annotation";
import {
  removeMarkFromAttachment,
  parseAnnotationAttachmentId,
} from "../../packages/workspace-ui/src/components/browser/lib/annotation-attachment";
import type { Attachment, BrowserMark } from "../../packages/contracts/src/types";

function attachment(marks: BrowserMark[], overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "browser-annotation:s1:browser_1",
    type: "design-selection",
    name: "Both of these sit too close",
    path: "http://localhost:5176/pricing",
    hostPath: "/assets/abc.png",
    designData: {
      screenshot: "asset://abc",
      pageURL: "http://localhost:5176/pricing?tab=year",
      viewport: { width: 1440, height: 900 },
      browserMarks: marks,
      annotationContext: [
        "![annotated browser](asset://abc)",
        "",
        "I marked up http://localhost:5176/pricing at 1440 × 900.",
        "",
        "Marks, numbered as they appear in the image:",
        ...marks.map((mark) => `${mark.pin}. <link> — ${mark.note ?? ""}`),
      ].join("\n"),
    },
    ...overrides,
  };
}

const MARKS: BrowserMark[] = [
  { id: "m4", tool: "pick", pin: 4, selector: "a.cta-download", note: "too close" },
  { id: "m5", tool: "region", pin: 5, selector: "section.pricing" },
];

describe("browserMarkChips", () => {
  it("carries each mark's own pin rather than its place in the row", () => {
    // The pin is a name shared with the page, the prompt, and the agent's
    // reply. A chip derived from array position renames every mark whenever an
    // earlier one is removed.
    const chips = browserMarkChips(attachment(MARKS));
    expect(chips.map((chip) => chip.pin)).toEqual([4, 5]);
  });

  it("labels a mark with no element by its first four words, in quotes", () => {
    const [chip] = browserMarkChips(
      attachment([
        { id: "m7", tool: "draw", pin: 7, note: "Copy is doing two jobs here at once" },
      ]),
    );
    expect(chip.isQuote).toBe(true);
    expect(chip.label).toBe("“Copy is doing two…”");
  });

  it("marks an unresolved element so the chip can strike it through", () => {
    const [chip] = browserMarkChips(attachment([{ id: "m1", tool: "pick", pin: 1 }]));
    expect(chip.resolved).toBe(false);
    expect(chip.title).toBe("Comment on mark 1");
  });

  it("keeps both ends of a long selector, because the ends identify it", () => {
    // End-truncation drops the class the whole selector exists to name.
    const shortened = middleEllipsis("button.checkout-primary-action-large", 20);
    expect(shortened.startsWith("button.")).toBe(true);
    expect(shortened.endsWith("large")).toBe(true);
    expect(shortened.length).toBe(20);
  });
});

describe("the label the chip prints", () => {
  it("never prints the guest's ref", async () => {
    // The guest mints `[data-solus-browser-ref="a1"]` as a handle for the drive
    // verbs. It identifies nothing to a reader and fills the chip end to end.
    const { createAnnotationAttachment } = await import(
      "../../packages/workspace-ui/src/components/browser/lib/annotation-attachment"
    );
    const built = createAnnotationAttachment({
      serverId: "s1",
      // SAFETY: the builder reads only these four members of the page; the rest
      // of `BrowserPage` is host and history state it never touches.
      page: {
        browserPageId: "browser_1",
        url: "http://localhost:5176/",
        viewport: { mode: "fill", width: 1297, height: 1167 },
        appearance: "system",
      } as never,
      state: {
        browserPageId: "browser_1",
        annotations: [
          {
            id: "m1",
            tool: "pick",
            number: 1,
            createdAt: 0,
            note: "too close",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            element: {
              role: "button",
              label: "Save changes",
              rect: { x: 0, y: 0, width: 10, height: 10 },
              ref: '[data-solus-browser-ref="a1"]',
            },
          },
        ],
      },
    });
    const [chip] = browserMarkChips(built!);
    expect(chip.label).toBe("button · Save changes");
    expect(chip.label).not.toContain("data-solus-browser-ref");
  });
});

describe("the page tail", () => {
  it("rides every chip, so a chip read alone can say where it came from", () => {
    // Not one shared chip: there is no second chip to read.
    const chips = browserMarkChips(attachment(MARKS));
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.host).toBe("localhost:5176");
      expect(chip.path).toBe("/pricing");
    }
  });

  it("drops the scheme, query and hash — they say nothing at chip size", () => {
    const [chip] = browserMarkChips(attachment([MARKS[0]]));
    expect(chip.path).toBe("/pricing");
    expect(chip.host).not.toContain("http");
  });

  it("never prints the capture's pixel dimensions", () => {
    // The resolution is the pane's business. On a chip it is a number the
    // reader has no use for, in the space the element name needs.
    const chip = browserMarkChips(attachment([MARKS[0]]))[0];
    expect(JSON.stringify(chip)).not.toContain("1440");
  });

  it("names the colour scheme only when it was not the app's own", () => {
    const themed = attachment([MARKS[0]]);
    themed.designData!.browserAppearance = "dark";
    expect(browserMarkChips(themed)[0].theme).toBe("dark");
    expect(browserMarkChips(attachment([MARKS[0]]))[0].theme).toBeNull();
  });

  it("says nothing rather than printing a malformed address", () => {
    const bare = attachment([MARKS[0]]);
    bare.designData!.pageURL = undefined;
    const [chip] = browserMarkChips(bare);
    expect(chip.host).toBeNull();
    expect(chip.path).toBe("");
  });
});

describe("removing one chip", () => {
  it("drops the mark's line from the prompt so the words match the chips", () => {
    const next = removeMarkFromAttachment(attachment(MARKS), "m4");
    expect(next?.designData?.browserMarks?.map((mark) => mark.pin)).toEqual([5]);
    expect(next?.designData?.annotations).toBeUndefined();
    expect(next?.designData?.annotationContext).not.toContain("4. ");
    expect(next?.designData?.annotationContext).toContain("5. ");
  });

  it("never renumbers the marks that stay", () => {
    const next = removeMarkFromAttachment(attachment(MARKS), "m4");
    expect(next?.designData?.browserMarks?.[0]?.pin).toBe(5);
  });

  it("removes the whole attachment once the last mark goes", () => {
    expect(removeMarkFromAttachment(attachment([MARKS[0]]), "m4")).toBeNull();
  });
});

describe("parseAnnotationAttachmentId", () => {
  it("names the page a chip came from, so removing it can clear the mark", () => {
    expect(parseAnnotationAttachmentId("browser-annotation:s1:browser_1")).toEqual({
      serverId: "s1",
      browserPageId: "browser_1",
    });
  });

  it("claims nothing about an attachment from another lane", () => {
    expect(parseAnnotationAttachmentId("file:/tmp/a.png")).toBeNull();
  });
});
