---
name: diagrams
description: Author or edit a Solus diagram work — architecture, system, data-flow, or ER/database diagrams rendered on an editable canvas. The diagram `content` is serialized JSON shaped `{"nodes":[...],"edges":[...]}`. Use whenever creating or updating a diagram via create_work/update_work; this skill owns the full node/edge contract, icons, data-model entities (typed fields + keys), relationship cardinality, groups, drill-down detail sub-diagrams, and click actions.
---

# Solus diagrams

A Solus `diagram` work is a node/edge graph rendered on an editable canvas. Unlike documents and slides (whose `content` is markdown), a diagram's `content` is **serialized JSON** shaped like `{"nodes":[...],"edges":[...]}`. The user can then drag, edit, and re-style every node and edge, so author clean declarative data — not a picture.

Create a diagram only when the user asks for a system/architecture/data diagram they can edit.

## Content contract

- `content` is a JSON string: `{"nodes": DiagramNode[], "edges": DiagramEdge[]}`.
- Every node needs a unique `id` and a `label`. Every edge needs a unique `id`, a `source`, and a `target` (both node ids).
- **Omit `position`** — Solus auto-layouts. Only set positions when revising a layout the user explicitly arranged.
- Prefer declarative fields over `html`. Add `actions` only when an interaction genuinely helps.
- Use only the optional fields that genuinely help; a sparse diagram reads better than a cluttered one.
- Nodes default to a rounded rectangle, but a simple label node can take a `shape` — use `"circle"` for a start/end terminator and `"diamond"` for a decision/branch point in flowcharts (see the `shape` row below).

## Architecture / system example

```json
{
  "nodes": [
    {
      "id": "api",
      "label": "API Server",
      "icon": "service",
      "subtitle": "Node.js · 3 instances",
      "badges": ["v2.1", "autoscaling"],
      "metrics": { "P95": "42ms", "RPS": "1.2k" },
      "body": "Handles REST requests and delegates to downstream services.",
      "actions": [{ "on": "click", "action": { "do": "focus" } }]
    },
    { "id": "db", "label": "PostgreSQL", "icon": "logos:postgresql" },
    { "id": "web", "label": "Web Client", "icon": "client" }
  ],
  "edges": [
    { "id": "e1", "source": "web", "target": "api", "label": "HTTPS" },
    { "id": "e2", "source": "api", "target": "db", "label": "SQL", "kind": "sync" }
  ]
}
```

## Data-model / ER example

A node carrying `fields` renders as an **entity** (a table of typed columns) instead of a service card. The presence of `fields` is the only thing that makes a node an entity — there is no separate flag. `cardinality` on an edge draws per-end **crow's-foot** markers (and replaces the arrowhead).

```json
{
  "nodes": [
    {
      "id": "users",
      "label": "users",
      "fields": [
        { "name": "id", "type": "uuid", "key": "pk" },
        { "name": "org_id", "type": "uuid", "key": "fk", "ref": "orgs.id" },
        { "name": "email", "type": "varchar(255)", "key": "unique" },
        { "name": "name", "type": "text", "nullable": true }
      ]
    },
    {
      "id": "orgs",
      "label": "orgs",
      "fields": [
        { "name": "id", "type": "uuid", "key": "pk" },
        { "name": "name", "type": "text" }
      ]
    }
  ],
  "edges": [
    { "id": "r1", "source": "orgs", "target": "users", "label": "has", "cardinality": "1-n" }
  ]
}
```

**Modeling rule:** for a database/ER diagram, make every node an entity (give each one `fields`) and use `cardinality` on the edges between them. For a data-flow diagram, mix entity nodes with regular service nodes.

## Node fields

| Field | Meaning |
|---|---|
| `icon` | Prefer a real brand/service/protocol logo via Iconify — `logos:postgresql`, `logos:redis`, `logos:kafka`, `logos:graphql`, `logos:docker`, `logos:aws`, `logos:nginx`, `logos:rabbitmq`, `logos:kubernetes`, or `simple-icons:<name>`. Fall back to generic glyphs: `service`, `db`, `queue`, `external`, `client`, `group`, `api`, `cache`, `auth`, `gateway`, `storage`, `function`, `broker`, `load_balancer`, `cdn`, `table`. Entities default to the `table` glyph. |
| `subtitle` | Short descriptor shown under the label. |
| `color` | CSS colour string that tints the node/group icon chip and badges. |
| `shape` | Card outline: `"rectangle"` (default, a rounded card) \| `"circle"` \| `"diamond"`. `circle`/`diamond` are decorative and only apply to a simple label node — a node with badges/fields/body/etc. stays a rectangle. Great for flowchart terminators (`circle`) and decisions (`diamond`). Ignored on group nodes. |
| `badges` | Compact chips for version, count, env, etc. |
| `metrics` | Key/value table shown on expand or in the details drawer. |
| `fields` | Typed columns that turn the node into a data-model entity. Each row: `{ "name", "type"?, "key"? ("pk"\|"fk"\|"unique"), "nullable"?, "ref"? }`. `ref` is a documentary `"table.column"` FK annotation. Ignored on group nodes (a group is a pure container). |
| `tags` | Smaller secondary labels. |
| `body` | Plain text shown on expand. |
| `html` | Sanitized HTML escape hatch; use `data-action="details\|focus\|expand\|openUrl"` for interactivity. Prefer declarative fields over this. |
| `actions` | `[{ "on": "click", "action": DiagramAction }]` — what clicking the node does. |
| `group` | `true` makes this node a container that other nodes nest inside. |
| `collapsed` | `true` on a group starts it folded to just its header. |
| `parentId` | `"<group-id>"` on a child node nests it inside a group. One level only. |
| `detail` | `{ "nodes": [...], "edges": [...] }` — a one-level nested sub-diagram revealed when the node is clicked (pair with the `drilldown` action). |

## DiagramAction vocabulary

| Action | Effect |
|---|---|
| `{ "do": "expand" }` | Toggle inline expanded body. |
| `{ "do": "details" }` | Open the side details drawer. |
| `{ "do": "focus" }` | Spotlight the node and its neighbours. |
| `{ "do": "drilldown" }` | Open the node's `detail` sub-diagram. |
| `{ "do": "openUrl", "url": "https://..." }` | Open an external link. |
| `{ "do": "openFile", "path": "src/..." }` | Ask the agent to open a file. |

## Edge fields

| Field | Meaning |
|---|---|
| `label` | Text shown on the edge. |
| `kind` | `"sync" \| "async" \| "data"` — async is animated/dashed, data is a thicker stroke. |
| `width` | Stroke width in px. |
| `shape` | `"smooth" \| "step" \| "straight"` routing. |
| `arrows` | `"none" \| "start" \| "end" \| "both"`. |
| `cardinality` | `"1-1" \| "1-n" \| "n-1" \| "n-n"`, ordered source→target. Draws per-end crow's-foot relationship markers and replaces the arrowhead. |
| `color` | Custom stroke colour (CSS string). |
| `animated` | `true` for a flowing dashed line. |
