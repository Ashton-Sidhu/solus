# Code Map Template

Use this template when the playground is about visualizing codebase architecture: component relationships, data flow, layer diagrams, and system architecture with interactive commenting.

## Layout

```
+-------------------+----------------------------------+
|  Controls:        |  SVG canvas                      |
|  • View presets   |  (nodes + connections)           |
|  • Layer toggles  |  with zoom controls              |
|  • Connection     |                                  |
|    type filters   |  Legend                          |
|  Comments (n):    +----------------------------------+
|  • List with      |  Prompt output  [ Copy ]         |
|    delete buttons |  selectable <textarea>           |
+-------------------+----------------------------------+
```

Use normal flow — no fixed positioning or nested scrolling. Outer body transparent.

## Control types for code maps

| Decision | Control | Example |
|---|---|---|
| System view | Preset buttons | Full System, Chat Flow, Data Flow, Agent System |
| Visible layers | Checkboxes | Client, Server, SDK, Data, External |
| Connection types | Checkboxes with colour swatches | Data Flow, Tool Calls, Events |
| Component feedback | Click-to-comment | Opens a small panel with a textarea |
| Zoom level | +/−/reset buttons | Scale the SVG for detail |

## Canvas rendering

Use an `<svg>` element with dynamically generated nodes and paths. Read colours from CSS variables so the map tracks the Solus theme.

- **Nodes:** rounded rectangles with a title and subtitle (file path).
- **Connections:** curved bezier paths with arrow markers, styled by type.
- **Layer organization:** group nodes into Y-position bands (e.g. y 30–80 = Client, y 130–180 = Server).
- **Click-to-comment:** click a node → open a panel → save → node gets a visual indicator.
- **Filtering:** toggle node visibility by layer and connection visibility by type.

```js
const nodes = [
  { id: 'api-client', label: 'API client', subtitle: 'src/api/client.ts',
    x: 100, y: 50, w: 140, h: 45, layer: 'client' },
];
const connections = [ { from: 'api-client', to: 'server', type: 'data-flow', label: 'HTTP' } ];
function renderDiagram() {
  const visible = nodes.filter(n => state.layers[n.layer]);
  connections.forEach(drawConnection); // under nodes
  visible.forEach(drawNode);           // on top
}
```

## Connection types and styling

Give each connection type a distinct dash pattern and a palette colour (used consistently in the legend and on the edges). Encode meaning, don't cycle a rainbow:

| Type | Colour | Style | Use for |
|---|---|---|---|
| `data-flow` | `--solus-art-5` (dusty blue) | Solid | request/response, data passing |
| `tool-call` | `--solus-art-3` (sage) | Dashed (6,3) | function calls, API invocations |
| `event` | `--solus-art-1` (terracotta) | Short dash (4,4) | async events, pub/sub |
| `dependency` | `--solus-art-border-strong` | Dotted | import/require relationships |

```html
<marker id="arrow-dataflow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
  <polygon points="0 0, 8 3, 0 6" fill="var(--solus-art-5)"/>
</marker>
```

## Layer fills

Assign each layer one palette colour, used consistently for every node in that layer (soft fill via `color-mix`):

| Layer | Fill |
|---|---|
| Client/UI | `--solus-art-5` (dusty blue) |
| Server/API | `--solus-art-2` (amber) |
| SDK/Core | `--solus-art-6` (plum) |
| Agent/Logic | `--solus-art-3` (sage) |
| Data | `--solus-art-1` (terracotta) |
| External | `--solus-art-4` (teal) |

```css
.node-client { fill: color-mix(in srgb, var(--solus-art-5) 18%, transparent); }
```

## Comment system

Click a node → open a panel with the component name, file path, and a textarea → save → add to the comments list and mark the node with a coloured border. The sidebar lists each comment with a delete button.

```js
state.comments.push({
  id: nextCommentId++,       // sequential id; do not use Date.now()
  target: node.id,
  targetLabel: node.label,
  targetFile: node.subtitle,
  text: userInput
});
```

## Prompt output for code maps

Combine system context with the user's comments, in a selectable `<textarea>`:

```
This is the [PROJECT] architecture, focusing on [visible layers].

Feedback on specific components:

**API client** (src/api/client.ts):
Add retry logic with exponential backoff here.

**Database manager** (src/db/manager.ts):
Add connection pooling — current code opens a new connection per request.
```

Only include comments the user added; mention which layers are visible if not the full system.

## Pre-populating with real data

- **Nodes:** 15–25 key components with real file paths.
- **Connections:** 20–40 relationships based on actual imports/calls.
- **Layers:** logical groupings (UI, API, Business Logic, Data, External), laid out in horizontal bands with consistent spacing.
- **Presets:** "Full System", "Frontend Only", "Backend Only", "Data Flow".

No raw grey, no gradients or glow, thin borders, sentence case, two font weights, nothing below 11px, no emoji. Animate node/edge entrance, filtering, and zoom smoothly; honour `prefers-reduced-motion`.

## Example topics

- Codebase architecture explorer (modules, imports, data flow)
- Microservices map (services, queues, databases, gateways)
- React component tree (components, hooks, context, state)
- Agent system (prompts, tools, skills, subagents)
- Data pipeline (sources, transforms, sinks, scheduling)

## Finish

Explain what you built in chat, then call `render_artifact` with the finished HTML as the last step.
