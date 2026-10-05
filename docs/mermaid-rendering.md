# Mermaid rendering

A fenced ```mermaid block is a diagram, and Solus draws it.

## In a reply

A mermaid fence is source while the message streams. When the closing fence
arrives, the block draws as inline SVG in the same frame chrome an HTML block
uses: hover actions for Show source, Copy source, and Expand. Expand opens the
fullscreen overlay; Escape or the backdrop closes it and returns focus to the
prompt. Show source flips back to the highlighted code block with a Diagram
action; the choice is not remembered.

The info string ` ```mermaid source ` keeps the block as code. It is the same
word an html fence uses.

A diagram that does not parse never shows an empty card. The block stays as
source, with the parser's message under it, and Copy still works.

The same `FencedBlock` renders replies, subagent transcripts, and subagent
reports, and the web client mounts the same component. Desktop, web, and mobile
draw the same diagram. Both providers emit plain markdown; nothing changes at
the agent boundary.

## In a document or plan

A ```mermaid fence in a document is a `mermaidBlock` node. It draws in place
with Edit, which reveals the Mermaid text and commits on blur or Done, and
Show as code, which turns the block back into a ```mermaid source fence. A
mermaid code block carries a `render` control that turns it back into a
diagram. The markdown never changes shape: the file stays a plain fence and
round-trips byte for byte.

Unlabelled fences render automatically when the first line of content is a
Mermaid declaration: `flowchart` or `graph` with a direction, `sequenceDiagram`,
`classDiagram`, `stateDiagram`, `stateDiagram-v2`, or `erDiagram`. Blank lines
and `%%` comments before the declaration are allowed. An explicit language
label takes precedence. Saving a detected diagram adds the `mermaid` fence
label and keeps its source text.

For other code blocks, select **mermaid** in the language menu to render the
diagram at once. Select **Show as code** to keep it as source; that choice
survives save and reopen. The dropdown uses the shared workspace menu.
Works, plans, and Markdown files support Mermaid on desktop, web, and mobile.

## Rendering

Two renderers draw a diagram. `renderMermaid` in
`conversation/lib/mermaid-block.ts` chooses one; replies and documents both
call it.

**beautiful-mermaid, in a worker.** Flowcharts, state, sequence, class, ER, and
xy-chart diagrams go to beautiful-mermaid
(`conversation/lib/mermaid-svg.worker.ts`). It needs no DOM, so layout and SVG
assembly run off the main thread in a few milliseconds. Its colours are Solus
theme variables, so the SVG follows a theme flip without a new render, and the
result is cached by source alone. Before the SVG goes inline,
`scopeDiagramSvg` (`conversation/lib/mermaid-svg.ts`) removes the library's web
font import, wraps each style block in `@scope` so it styles only its own SVG,
and prefixes every marker id so that two diagrams never share one. Every
colour is set explicitly: the library falls back to `var(--accent)` and
`var(--border)`, which would inherit shadcn's variables of the same names.
The worker starts while a mermaid fence is still streaming, so the layout
engine is warm when the fence closes. This renderer does not report most syntax
errors: a malformed diagram of a supported type can draw in part rather than
stay as source.

**Mermaid, in a hidden frame.** Every other diagram (gantt, pie, mindmap, a
diagram with frontmatter or a `%%{init}%%` directive), and any diagram the
worker cannot parse, goes to Mermaid. Mermaid wraps a label by measuring it
word by word, and each measurement forces a style recalculation of the whole
document it is in. In the workspace that cost about 4 ms per measurement and
half a second per diagram. Mermaid therefore runs in its own realm, in a hidden
same-origin frame (`conversation/lib/mermaid-frame.ts`) whose document holds
only the diagram, and returns the SVG string. It loads only when a diagram
needs it. `initialize` runs once per theme, not per diagram. Renders run one at
a time because Mermaid's configuration is global, and the result is cached by
theme and source. The security level is `strict` and Mermaid's own error
graphic is suppressed.

Either way, a block starts its render only when it comes within a screen of the
viewport: every tab stays mounted, and diagrams in tabs the reader is not
looking at must not queue ahead of the one they are.

A diagram that Mermaid draws is made to look like a Solus diagram work. The values come
from the diagram canvas (`DiagramNode`, `DiagramGroupNode`, `DiagramEdge`,
`DiagramShell.css`): a node is a container-coloured card with a hairline
`--solus-tool-border`, 10px radius and the faint ambient lift; a subgraph is
the accent-washed group frame; edges are the parchment ink a step lighter than
text (`#c3b7a6` / `#a89a88`, translucent white in dark mode) at 1.3px; edge
labels are 12px tertiary text on a container-coloured pill. The canvas is
plain container colour, no dot grid. In a reply the canvas takes the full transcript column (`data-conversation-preview`), like an
HTML block, and the diagram sits at its own size inside it. The rules go in
through `themeCSS`, which Mermaid nests under the SVG's own id, so they win
without `!important`; the surface colours are CSS variables, so light and dark
both hold. The `classic` look and `dagre` layout are set explicitly: Mermaid 12 defaults
flowcharts to its `neo` look with drop shadows and to ELK, a 1.4 MB chunk. Labels
render as SVG text rather than HTML: HTML labels are measured against a font the
pane may not have, and the mismatch clips long labels.
