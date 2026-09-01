# Concept Map Template

Use this template when the playground is about learning, exploration, or mapping relationships: concept maps, knowledge gap identification, scope mapping, task decomposition with dependencies.

## Layout

```
+--------------------------------------+
|  Canvas (draggable nodes, edges)     |
|  with tooltip on hover               |
+-------------------------+------------+
|  Sidebar:               | Prompt     |
|  • Knowledge levels     | output     |
|  • Connection types     |            |
|  • Node list            | [ Copy ]   |
|  • Actions              |            |
+-------------------------+------------+
```

Canvas playgrounds differ from the two-panel split: the interactive visual IS the control — users drag nodes and draw connections rather than adjusting sliders. The sidebar supplements with toggles and list controls. Use normal flow; keep the outer body transparent.

## Control types for concept maps

| Decision | Control | Example |
|---|---|---|
| Knowledge level per node | Click-to-cycle button in sidebar list | Know → Fuzzy → Unknown |
| Connection type | Selector before drawing | calls, depends on, contains, reads from |
| Node arrangement | Drag on canvas | spatial layout reflects mental model |
| Which nodes to include | Toggle/checkbox per node | hide/show concepts |
| Actions | Buttons | auto-layout (force-directed), clear edges, reset |

## Canvas rendering

Use a `<canvas>` element with manual draw calls. Read colours from CSS variables via `getComputedStyle(document.documentElement)` so the canvas tracks the Solus theme.

- **Hit testing:** check mouse position against node bounding circles on mousedown/mousemove
- **Drag:** on mousedown on a node, track offset and update position on mousemove
- **Edge drawing:** click node A, then node B; draw an arrow with the selected relationship type
- **Tooltips:** on hover, position a div absolutely over the canvas with description text
- **Force-directed auto-layout:** simple spring simulation — repulsion between all pairs, attraction along edges, iterate 100–200 times with damping

```js
const css = getComputedStyle(document.documentElement);
const NODE = css.getPropertyValue('--solus-art-raised').trim();
const EDGE = css.getPropertyValue('--solus-art-border-strong').trim();
function draw() {
  ctx.clearRect(0, 0, W, H);
  edges.forEach(e => drawEdge(e));  // edges first, under nodes
  nodes.forEach(n => drawNode(n));  // nodes on top
}
```

Encode knowledge level with meaning, not a rainbow: e.g. Know → `--solus-art-positive`, Fuzzy → `--solus-art-2` (amber), Unknown → `--solus-text-tertiary`.

## Prompt output for concept maps

A targeted learning request shaped by the user's knowledge markings:

> "I'm learning [CODEBASE/DOMAIN]. I already understand: [know nodes]. I'm fuzzy on: [fuzzy nodes]. I have no idea about: [unknown nodes]. Here are the relationships I want to understand: [edge list in natural language]. Please explain the fuzzy and unknown concepts, focusing on these relationships. Build on what I already know. Use concrete code references."

Only include edges the user drew and concepts they marked fuzzy or unknown. Put the text in a selectable readonly `<textarea>` with a copy button.

## Pre-populating with real data

For a codebase or domain, pre-populate:
- **Nodes:** 15–20 key concepts with real file paths and short descriptions
- **Edges:** 20–30 pre-drawn relationships based on actual architecture
- **Knowledge:** default all to "Fuzzy" so the user adjusts from there
- **Presets:** "Zoom out" (show only top-level nodes), "Focus on [layer]" (highlight one area)

## Solus styling notes

No raw grey, no gradients or glow, thin borders, sentence case, two font weights, nothing below 11px, no emoji. Animate node drag, edge draw, and auto-layout settling smoothly; honour `prefers-reduced-motion`.

## Example topics

- Codebase architecture map (modules, data flow, state management)
- Framework learning (how React hooks connect, data-fetching layers)
- System design (services, databases, queues, caches and how they relate)
- Task decomposition (goals → sub-tasks with dependency arrows, knowledge tags)
- API surface map (endpoints grouped by resource, shared middleware, auth layers)

## Finish

Explain what you built in chat, then call `render_artifact` with the finished HTML as the last step.
