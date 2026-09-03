# 0020. Google Docs publish and pull use the Docs API, not Drive import

## Status

Accepted, 2026-09-02.

## Context

Publishing a work or a plan to Google used Drive's import: Solus uploaded
markdown, later HTML, and let Drive convert it into a Google Doc. Pulling used
Drive's markdown export. Both converters are Google's, and both change the
document's structure in ways Solus cannot control:

- The importer drops stylesheets, `<figure>`, `<pre>`, and `max-width`, so
  prose sizing, code blocks, and image bounds never reach the document.
- The exporter joins paragraphs with hard breaks, prefixes bullets with `>`,
  wraps headings in bold, and escapes ordinary punctuation. A pulled document
  is unreadable in the Solus editor.

Inline styles improved the publish but not enough, and the pull stayed broken.

## Decision

Solus writes the document body itself through the Docs API `batchUpdate`, one
request per paragraph, run, bullet, table cell, and image, and reads it back
through `documents.get`. Google's converters are not used in either direction.

- Headings are named styles. Bullets are real list paragraphs with a nesting
  level. Code is Courier New paragraphs with shading. Tables are inserted
  empty, read back to learn their cell indices, and filled last to first.
- A diagram PNG is staged as a Drive file readable by link for the seconds
  the insert takes, then deleted; the document keeps its own copy. The Docs
  API takes images by URL only.
- The caption paragraph under a diagram carries its title. On pull, the
  link's `diagrams` list matches the caption back to its `work://embed` token.
  Any other image is named in `lossyParts` and dropped, never inlined as
  base64.
- Every diagram is one picture on a landscape page of its own, with half-inch
  margins — 960 px of width against the body's 624 px — and the prose after it
  returns to portrait. Consecutive figure pages share one section, a document
  never ends on an empty portrait page, and every publish resets the first
  section to portrait before writing, since clearing the body keeps that
  section's style. On pull, section breaks are structure without content and
  read through.
- The figure fills its page. A figure area is the page less 64 px for the
  caption and 96 px for the heading (960×560 px), and the drawing fills that
  area on whichever axis runs out first. The server reads only the PNG's
  aspect ratio; how many pixels are in it is the client's business.
- The heading immediately before an embed is lifted onto the figure page with
  it. A diagram dense enough to need a whole page is read on that page, and a
  heading left in the prose section is the last line of the page before. The
  reserved room is why the figure cannot push it off; for a wide drawing,
  which the page bounds by width, reserving it costs nothing at all.
- A page figure is rasterized for where it lands, not for the canvas it came
  from — the ratio is the page fit times 500 dpi over CSS's 96. Rasterizing at
  a fixed 2× the canvas and then enlarging the figure to fill the page is how
  a small diagram reached the page at about 105 dpi. The target is 500 because
  these diagrams are read zoomed in: Docs at 200% zoom on a high-density
  display paints a figure at four times its CSS size, 384 dpi, before Docs
  resamples anything. The floor is the export's own 2× and the ceiling is its
  20-megapixel budget, which stays clear of the 25 megapixels at which Docs
  refuses an inline image.
- The staging upload to Drive is resumable, not multipart: a figure at this
  resolution passes multipart's 5 MB limit.
- The capture has one margin, stated once: the frame is the graph plus 80 px,
  drawn at 1:1 and centred. It used to also pass a 12% inset to
  `getViewportForBounds`, which spent an eighth of the reader's figure on
  white.
- A page figure is drawn in print type: the node card is scaled to 0.8 and its
  label set at 20 px, against the canvas's full-width card and 14 px. A reader
  pans and zooms a canvas, so a card there can be wide with a small label; a
  page figure is fixed, and the page bounds these drawings by width. Measured
  on a 20-node architecture diagram, the drawing packs 12% narrower and its
  titles land 21% larger on the page. The sizes are absolute, not scaled by
  the publisher's font setting, so a published document reads the same
  whoever published it.
- The client always lays the diagram out again for the page. The canvas is
  spaced for panning, so the publish packs the graph with print spacing (40 px
  between nodes, 64 px between ranks, against the canvas's 120 and 140) in
  both flow directions, top-to-bottom and left-to-right, and captures
  whichever the page shows largest; the drawing as authored is captured only
  when the content cannot be laid out. Both re-layouts are packed against the
  card sizes the first mount measured, since the size estimate reads a card's
  label but not its subtitle or badges and would overlap neighbours at print
  spacing.
- The published document wears the Solus document style, read from
  `workspace-ui/src/index.css`: nothing sits on a fill. A code span is the
  mono face in strong ink with no chip; a code block is a left rule and the
  mono face, not a framed card; a table opens and closes on a warm rule,
  separates rows with a fainter one, has no vertical grid and no header fill,
  and marks its header with the mono face in tertiary ink. The header is not
  bolded or upper-cased into the text, because Docs has no text-transform and
  either would change what a pull reads back; the pull therefore treats the
  mono face in a header cell as a label rather than as code.
- No new scope. The Docs API accepts `drive.file` for documents Solus created
  and `drive.readonly` for the rest. The Docs API must be enabled on the Solus
  Google Cloud project; a disabled API is reported by name.

## Consequences

Publish and pull are deterministic and round-trip. A publish costs one
`batchUpdate` per run of paragraphs plus three requests per table, instead
of one upload. Confluence is unaffected; it still converts through its own
storage format.
