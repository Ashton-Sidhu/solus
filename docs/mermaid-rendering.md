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
reports, and the web client mounts the same component. Desktop and web
draw the same diagram. The native mobile Markdown renderer is separate and
does not use this rendering path. Both providers emit plain markdown; nothing changes at
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
Works, plans, and Markdown files use this renderer on desktop and web.

## Rendering

All diagrams use Mermaid through `renderMermaid` in
`conversation/lib/mermaid-block.ts`. Replies and documents use the same renderer.

Mermaid runs in a hidden same-origin iframe
(`conversation/lib/mermaid-frame.ts`). Its text measurements affect only that
small document, rather than the full workspace. The iframe still uses the main
thread; it reduces layout work but does not move rendering to a worker.

The renderer loads once, on demand. A streaming Mermaid fence starts loading it
before the closing fence arrives. Conversation diagrams render only near the
viewport, so hidden tabs do not queue diagrams ahead of the visible tab.
Results are cached by source and theme. Reopening a diagram or returning to a
previous theme reuses the result. Renders run one at a time because Mermaid's
configuration is global; `initialize` runs only when the theme changes.

The security level is `strict`. Mermaid's own error graphic is suppressed;
parse errors leave the source and an error message visible.

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
