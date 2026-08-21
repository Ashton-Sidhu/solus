import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readUiSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src', path), 'utf8')

const previewSource = readUiSource('components/diagram/DiagramPreview.svelte')
const shellSource = readUiSource('components/diagram/DiagramShell.svelte')
const shellCss = readUiSource('components/diagram/DiagramShell.css')
const registrySource = readUiSource('components/diagram/lib/canvas-registry.ts')
const zoomControlsSource = readUiSource('components/diagram/CanvasZoomControls.svelte')
const toolbarSource = readUiSource('components/diagram/CanvasToolbar.svelte')
const crumbsSource = readUiSource('components/diagram/DiagramDrillCrumbs.svelte')
const nodeSource = readUiSource('components/diagram/nodes/DiagramNode.svelte')
const groupSource = readUiSource('components/diagram/nodes/DiagramGroupNode.svelte')
const edgeSource = readUiSource('components/diagram/edges/DiagramEdge.svelte')
const embedSource = readUiSource('components/editor/DiagramEmbedNodeView.svelte')
const extensionSource = readUiSource('components/editor/diagramEmbedExtension.ts')
const planMessageSource = readUiSource('components/plan/PlanMessageItem.svelte')

describe('diagram preview canvas', () => {
  test('renders the real graph with every authoring affordance unwired', () => {
    // WHY: the preview reuses the shell's node, group and edge components so a
    // reader sees the same diagram they would open. That reuse is only safe
    // while every editing path stays off — one wired handler turns a document
    // into an editor that cannot save.
    expect(previewSource).toContain('DIAGRAM_NODE_TYPES')
    expect(previewSource).toContain('DIAGRAM_EDGE_TYPES')
    expect(previewSource).toContain('nodesDraggable={false}')
    expect(previewSource).toContain('nodesConnectable={false}')
    expect(previewSource).toContain('elementsSelectable={false}')
    const handlers = previewSource.slice(
      previewSource.indexOf('const nodeHandlers = {'),
      previewSource.indexOf('$effect('),
    )
    expect(handlers).toContain('resizable: false')
    expect(handlers).not.toContain('onLabelChange')
    expect(handlers).not.toContain('onResize')
    expect(handlers).not.toContain('onContextMenu')
    expect(handlers).not.toContain('onSelect')
  })

  test('keeps the affordances reading needs — expand, drill, collapse, zoom, fit', () => {
    // WHY: "semi live" is the point. Strip these and the preview is a picture
    // again, and a node's detail sub-diagram becomes unreachable without
    // opening the full canvas.
    expect(previewSource).toContain("case \"expand\"")
    expect(previewSource).toContain("case \"drilldown\"")
    expect(previewSource).toContain('onToggleCollapse: toggleCollapse')
    expect(previewSource).toContain('<CanvasZoomControls')
    expect(zoomControlsSource).toContain('flow.zoomIn')
    expect(zoomControlsSource).toContain('flow.zoomOut')
    expect(zoomControlsSource).toContain('flow.fitView')
  })

  test('a swapped view re-fits, so drilling never lands off the graph', () => {
    // WHY: the canvas keeps the previous viewport across a view change; a
    // sub-diagram laid out elsewhere would open on empty space.
    expect(previewSource).toMatch(/flowControls\?\.fitView\(/)
  })

  test('the wheel drives the canvas, but one finger still scrolls the page', () => {
    // WHY: hovering a diagram hands the wheel to the diagram, the same as the
    // full editor — so the preview must NOT opt out of scroll capture. Touch is
    // the one exception: without it a phone reader cannot swipe past an embed.
    expect(previewSource).not.toContain('preventScrolling')
    expect(previewSource).toContain('panOnDrag={runtime.isTouchDevice ? [1, 2] : true}')
  })

  test('the embedded frame follows the monitor, not the window', () => {
    // WHY: a desktop display has room to read a graph without zooming; a laptop
    // does not. `is-laptop-display` is the monitor axis (ADR-0010) and this is
    // geometry, which is the one thing it may carry.
    const embedStyles = embedSource.slice(embedSource.indexOf('<style>'))
    expect(embedStyles).toContain('height: 28rem;')
    expect(embedStyles).toMatch(
      /:global\(html\.is-laptop-display\) \.diagram-embed__canvas \{\s*height: 20rem;/,
    )
    // A short pane or a phone still caps it.
    expect(embedSource).toContain('max-h-[55cqh]')
  })
})

describe('the two canvases share their parts', () => {
  test('one registry decides what a node and an edge look like', () => {
    // WHY: a node type registered on one canvas and forgotten on the other
    // renders as an xyflow default box — a silent, shippable drift. Both
    // surfaces read the same registry so there is only one list to update.
    expect(registrySource).toContain('DiagramNodeComponent')
    expect(registrySource).toContain('DiagramGroupNode')
    expect(registrySource).toContain('DiagramEdgeComponent')
    expect(shellSource).toContain('const nodeTypes = DIAGRAM_NODE_TYPES;')
    expect(shellSource).toContain('const edgeTypes = DIAGRAM_EDGE_TYPES;')
    // The transcript thumbnail imports flow-builders for one dash helper, so
    // the registry may not live there — that would pull three card components
    // into every transcript chunk.
    expect(readUiSource('components/diagram/lib/flow-builders.ts')).not.toMatch(
      /from ['"][^'"]+\.svelte['"]/,
    )
  })

  test('the dot grid, the zoom cluster and the drill trail have one home each', () => {
    // WHY: each of these was duplicated between the shell and the preview while
    // this feature was being built. Duplicated chrome is how two surfaces that
    // must read as one surface stop doing so.
    for (const source of [shellSource, previewSource]) {
      expect(source).toContain('<DiagramCanvasBackground />')
      expect(source).toContain('DiagramDrillCrumbs')
    }
    expect(toolbarSource).toContain('<CanvasZoomControls />')
    expect(toolbarSource).not.toContain('flow.zoomIn')
    expect(crumbsSource).toContain('class="drill-crumbs"')
  })

  test('the control-bar chrome is stylesheet-owned, so both canvases wear it', () => {
    // WHY: the styles were scoped inside CanvasToolbar, which meant the same
    // markup rendered unstyled anywhere else. They now sit on the board in
    // DiagramShell.css, which every canvas surface loads.
    expect(shellCss).toContain('.diagram-shell__board .canvas-toolbar {')
    expect(shellCss).toContain('.diagram-shell__board .canvas-toolbar__btn {')
    expect(shellCss).toContain('.diagram-shell__board .canvas-toolbar__zoom {')
    expect(toolbarSource).not.toContain('<style>')
    expect(zoomControlsSource).not.toContain('<style>')
  })
})

describe('shared diagram cards in read-only contexts', () => {
  test('label editing needs a commit handler, everywhere it is offered', () => {
    // WHY: without a commit handler the input opens, takes the user's typing,
    // and throws it away on blur. Absent handler must mean absent affordance.
    expect(nodeSource).toContain('ondblclick={data.onLabelChange ? editor.start : undefined}')
    expect(nodeSource).toContain("if (e.key === 'F2') { if (data.onLabelChange) editor.start(e); return }")
    expect(groupSource).toContain('ondblclick={data.onLabelChange ? editor.start : undefined}')
    expect(groupSource).toContain("if (e.key === 'F2' && data.onLabelChange) editor.start(e)")
    expect(edgeSource).toContain('if (!data?.onLabelChange) return;')
    expect(edgeSource).toContain('{:else if label && data?.onLabelChange}')
  })

  test('a group hides its resize frame when the host declares it read-only', () => {
    // WHY: the node card already honours `resizable`; the group ignored it, so
    // a read-only canvas still handed out resize handles.
    expect(groupSource).toContain('{#if !data.collapsed && data.resizable !== false}')
  })
})

describe('diagram surfaces offer both ways in', () => {
  test('the document embed opens focused or in split, and reads in place', () => {
    // WHY: the embed used to be one big button whose only action opened the
    // pane. A live canvas needs its actions in the header instead, and it needs
    // both destinations — the split is what keeps the document on screen.
    expect(embedSource).toContain('onOpen(workId)')
    expect(embedSource).toContain('onOpenSecondary(workId)')
    expect(embedSource).toContain('Open in split')
    expect(embedSource).toContain('DiagramPreview.svelte')
  })

  test('ProseMirror lets the canvas keep its own pointer events', () => {
    // WHY: the embed is a draggable atom node. Without this the editor claims
    // the drag as a block move and the graph cannot be panned at all.
    expect(extensionSource).toContain("closest('button, .diagram-embed__canvas')")
    expect(embedSource).toContain('diagram-embed__canvas')
  })

  test('the conversation diagram card offers the split action the document card does', () => {
    // WHY: the two cards sit next to each other in the same transcript; one
    // offering a labelled split action and the other not reads as a bug.
    const diagramCard = planMessageSource.slice(
      planMessageSource.indexOf('data-testid="diagram-card"'),
      planMessageSource.indexOf('data-testid="document-card"'),
    )
    expect(diagramCard).toContain('Open in split')
    expect(diagramCard).toContain('openWorkSecondary()')
  })
})
