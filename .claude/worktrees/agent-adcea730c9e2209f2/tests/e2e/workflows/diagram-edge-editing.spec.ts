import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

async function openDiagramShell(page: any) {
  const app = new AppPage(page)
  const conversation = new ConversationPage(page)
  await app.waitForAppReady()

  await conversation.typeAndSend('__MOCK_DIAGRAM__ show me the architecture')

  const ACTIVE_SHELL = '.mode-shell:not(.mode-hidden)'
  const ACTIVE_TAB = `${ACTIVE_SHELL} .tab-slot:not(.tab-hidden)`
  const diagramCard = page.locator(`${ACTIVE_TAB} [data-testid="diagram-card"]`)
  await diagramCard.waitFor({ state: 'visible', timeout: 10_000 })
  await diagramCard.locator('.plan-card-header').first().click()

  const diagramShell = page.locator('.mode-shell:not(.mode-hidden) .diagram-shell')
  await diagramShell.waitFor({ state: 'visible', timeout: 5_000 })
  return diagramShell
}

// Click (or right-click) an edge ON ITS PATH, near the source end. Two traps
// make the obvious `edge.click()` unusable: a straight horizontal edge has a
// zero-height bounding box (Playwright deems it invisible), and the box centre
// is occupied by the floating label — which lives in a portaled overlay, so a
// click there starts label editing instead of reaching the edge element.
async function clickEdgePath(
  page: any,
  edge: any,
  button: 'left' | 'right' = 'left',
) {
  const box = (await edge.locator('.svelte-flow__edge-path').first().boundingBox())!
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { button })
}

test.describe('Diagram edge label editing', () => {
  test('edge labels are rendered as interactive elements', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const edgeLabels = shell.locator('.edge-label-display')
    await expect(edgeLabels.first()).toBeVisible({ timeout: 5_000 })
  })

  test('clicking an edge label opens inline input', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const edgeLabel = shell.locator('.edge-label-display').first()
    await edgeLabel.waitFor({ state: 'visible', timeout: 5_000 })
    await edgeLabel.click()

    const input = shell.locator('.edge-label-input')
    await expect(input).toBeVisible({ timeout: 2_000 })
    await expect(input).toBeFocused()
  })

  test('pressing Enter commits edge label edit', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const edgeLabel = shell.locator('.edge-label-display').first()
    await edgeLabel.waitFor({ state: 'visible', timeout: 5_000 })
    await edgeLabel.dblclick()

    const input = shell.locator('.edge-label-input')
    await input.fill('Updated Label')
    await page.keyboard.press('Enter')

    await expect(input).toBeHidden({ timeout: 2_000 })
    // The committed label re-mounts (it can re-append within the label layer,
    // changing DOM order), so assert by text rather than position.
    await expect(
      shell.locator('.edge-label-display', { hasText: 'Updated Label' }),
    ).toBeVisible()
  })

  test('pressing Escape cancels edge label edit', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const edgeLabel = shell.locator('.edge-label-display').first()
    await edgeLabel.waitFor({ state: 'visible', timeout: 5_000 })
    const originalText = await edgeLabel.textContent()
    await edgeLabel.dblclick()

    const input = shell.locator('.edge-label-input')
    await input.fill('Should be cancelled')
    await page.keyboard.press('Escape')

    await expect(input).toBeHidden({ timeout: 2_000 })
    // Same DOM-order caveat as the commit test: find the label by its text.
    await expect(
      shell.locator('.edge-label-display', { hasText: originalText?.trim() ?? '' }),
    ).toBeVisible()
  })
})

test.describe('Diagram edge reconnection', () => {
  // Drag from an absolute viewport point to another, in steps so xyflow's
  // connection handler registers the intermediate moves (a single jump can be
  // dropped, and the connectionRadius snap needs a settled final position).
  async function dragTo(page: any, fromX: number, fromY: number, toX: number, toY: number) {
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2, { steps: 8 })
    await page.mouse.move(toX, toY, { steps: 8 })
    await page.mouse.up()
  }

  test('selecting an edge reveals draggable endpoint anchors', async ({ page }) => {
    const shell = await openDiagramShell(page)

    // No anchors until the edge is selected — they only appear on demand so the
    // hotspots don't sit over the node handles for unselected edges.
    await expect(shell.locator('.edge-reconnect-dot')).toHaveCount(0)

    await clickEdgePath(page, shell.locator('[data-id="e1"]'))

    // Source + target grab dots both appear once the edge is selected.
    await expect(shell.locator('.edge-reconnect-dot')).toHaveCount(2, { timeout: 3_000 })
    await expect(shell.locator('.svelte-flow__edgeupdater-source')).toBeVisible()
  })

  test('dragging the source endpoint to another side of the node reroutes the edge', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    // Select e1 (Web Client → API Server) so its endpoint anchors render.
    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)
    const pathLoc = edge.locator('.svelte-flow__edge-path')
    const before = await pathLoc.getAttribute('d')

    // Drag the source endpoint from the node's right side (its default source
    // handle) up to the top of the same node, landing on the top source handle.
    const anchor = shell.locator('.svelte-flow__edgeupdater-source')
    const aBox = (await anchor.boundingBox())!
    const webNode = shell.locator('.svelte-flow__node', { hasText: 'Web Client' })
    const nBox = (await webNode.boundingBox())!

    await dragTo(
      page,
      aBox.x + aBox.width / 2,
      aBox.y + aBox.height / 2,
      nBox.x + nBox.width / 2,
      nBox.y + 3,
    )

    // The reconnect must REROUTE the edge (new geometry), not drop it: the edge
    // still exists and still connects the same two nodes — only its attachment
    // side changed. This is the whole point of moving an endpoint.
    await expect(edge).toHaveCount(1)
    await expect(pathLoc).not.toHaveAttribute('d', before ?? '', { timeout: 3_000 })
  })

  // Each node side stacks a source and a target handle on the same spot, and
  // xyflow validates a drop against the handle directly under the pointer.
  // These two tests drop EXACTLY on the visible dot — one per endpoint type —
  // so a wrong-type handle winning the hit test (which silently snaps the edge
  // back) can't regress.
  test('dropping the source endpoint exactly on a connection dot rewires it', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)
    const pathLoc = edge.locator('.svelte-flow__edge-path')
    const before = await pathLoc.getAttribute('d')

    // Drag the source endpoint onto the centre of Web Client's bottom source
    // dot — the drop must land on the source half of the stacked pair.
    const anchor = shell.locator('.svelte-flow__edgeupdater-source')
    const aBox = (await anchor.boundingBox())!
    const dot = shell.locator(
      '.svelte-flow__handle.source[data-nodeid="web"][data-handlepos="bottom"]',
    )
    const dBox = (await dot.boundingBox())!

    await dragTo(
      page,
      aBox.x + aBox.width / 2,
      aBox.y + aBox.height / 2,
      dBox.x + dBox.width / 2,
      dBox.y + dBox.height / 2,
    )

    await expect(edge).toHaveCount(1)
    await expect(pathLoc).not.toHaveAttribute('d', before ?? '', { timeout: 3_000 })
  })

  test('dropping the target endpoint (arrow end) exactly on a connection dot rewires it', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)
    const pathLoc = edge.locator('.svelte-flow__edge-path')
    const before = await pathLoc.getAttribute('d')

    // Drag the arrow end from API Server's left side onto the centre of its
    // bottom target dot. The source handle stacked on top must not block it.
    const anchor = shell.locator('.svelte-flow__edgeupdater-target')
    const aBox = (await anchor.boundingBox())!
    const dot = shell.locator(
      '.svelte-flow__handle.target[data-nodeid="api"][data-handlepos="bottom"]',
    )
    const dBox = (await dot.boundingBox())!

    await dragTo(
      page,
      aBox.x + aBox.width / 2,
      aBox.y + aBox.height / 2,
      dBox.x + dBox.width / 2,
      dBox.y + dBox.height / 2,
    )

    await expect(edge).toHaveCount(1)
    await expect(pathLoc).not.toHaveAttribute('d', before ?? '', { timeout: 3_000 })
  })

  test('dragging a left-side endpoint to the right side reroutes instead of creating an edge', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)

    const targetAnchor = shell.locator('.svelte-flow__edgeupdater-target')
    const targetAnchorBox = (await targetAnchor.boundingBox())!
    const bottomTarget = shell.locator(
      '.svelte-flow__handle.target[data-nodeid="api"][data-handlepos="bottom"]',
    )
    const bottomTargetBox = (await bottomTarget.boundingBox())!

    // First put the arrow end on a non-default left-side alternative. The
    // follow-up drag starts from a selected edge endpoint sitting directly over a
    // node handle; it must hit the reconnect anchor, not start a fresh edge.
    await dragTo(
      page,
      targetAnchorBox.x + targetAnchorBox.width / 2,
      targetAnchorBox.y + targetAnchorBox.height / 2,
      bottomTargetBox.x + bottomTargetBox.width / 2,
      bottomTargetBox.y + bottomTargetBox.height / 2,
    )

    const reroutedAnchorBox = (await targetAnchor.boundingBox())!
    const pathLoc = edge.locator('.svelte-flow__edge-path')
    const before = await pathLoc.getAttribute('d')
    const rightTarget = shell.locator(
      '.svelte-flow__handle.target[data-nodeid="api"][data-handlepos="right"]',
    )
    const rightTargetBox = (await rightTarget.boundingBox())!
    const edgeCountBefore = await shell.locator('.svelte-flow__edge').count()

    await dragTo(
      page,
      reroutedAnchorBox.x + reroutedAnchorBox.width / 2,
      reroutedAnchorBox.y + reroutedAnchorBox.height / 2,
      rightTargetBox.x + rightTargetBox.width / 2,
      rightTargetBox.y + rightTargetBox.height / 2,
    )

    await expect(edge).toHaveCount(1)
    await expect(shell.locator('.svelte-flow__edge')).toHaveCount(edgeCountBefore)
    await expect(pathLoc).not.toHaveAttribute('d', before ?? '', { timeout: 3_000 })
  })

  test('dropping an endpoint anywhere on another node card rewires the edge to it', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    // Select e1 (Web Client → API Server) so its endpoint anchors render, then
    // close the drawer via its button so it can't cover the drop zone (Escape
    // would also clear the edge selection and hide the anchors).
    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)
    await shell.locator('.diagram-drawer__close').click()

    const anchor = shell.locator('.svelte-flow__edgeupdater-target')
    const aBox = (await anchor.boundingBox())!
    const db = shell.locator('.svelte-flow__node[data-id="db"]')
    const dBox = (await db.boundingBox())!

    // Drop on the MIDDLE of the Database card — nowhere near a connection dot.
    // This is the core promise: attaching an edge to a node must not require
    // pixel-hunting the handles.
    await dragTo(
      page,
      aBox.x + aBox.width / 2,
      aBox.y + aBox.height / 2,
      dBox.x + dBox.width / 2,
      dBox.y + dBox.height / 2,
    )

    // Rewired, not duplicated or dropped...
    await expect(shell.locator('.svelte-flow__edge')).toHaveCount(2)
    // ...and e1 now ends at Database — the drawer's connection row proves the
    // retarget reached the model, not just the rendered path.
    await clickEdgePath(page, edge)
    const drawer = shell.locator('.diagram-drawer[aria-label="Edit edge"]')
    await expect(drawer.locator('.diagram-edge-conn__node').last()).toHaveText(
      'Database',
      { timeout: 3_000 },
    )
  })

  test('dragging from a handle and dropping on a node body creates an edge to it', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)
    const edgesLoc = shell.locator('.svelte-flow__edge')
    const before = await edgesLoc.count()

    // Surface Web Client's handles, then drag from its bottom source dot to a
    // point inside the Kubernetes group that is far from every connection dot
    // (and outside the nested Worker card) — only the drop-on-node-body
    // fallback can land this one.
    const web = shell.locator('.svelte-flow__node[data-id="web"]')
    await web.hover()
    const handle = shell.locator(
      '.svelte-flow__handle.source[data-nodeid="web"][data-handlepos="bottom"]',
    )
    const hBox = (await handle.boundingBox())!
    const group = shell.locator('.svelte-flow__node[data-id="cluster"]')
    const gBox = (await group.boundingBox())!

    await dragTo(
      page,
      hBox.x + hBox.width / 2,
      hBox.y + hBox.height / 2,
      gBox.x + gBox.width * 0.85,
      gBox.y + gBox.height * 0.15,
    )

    await expect(edgesLoc).toHaveCount(before + 1, { timeout: 3_000 })
    // The new edge connects Web Client to the group it was dropped on.
    await expect(shell.locator('[data-id^="e-web-cluster"]')).toHaveCount(1)
  })

  test('dropping an endpoint on empty canvas leaves the edge unchanged', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)
    // Close the drawer via its button — Escape would clear the selection too.
    await shell.locator('.diagram-drawer__close').click()
    const pathLoc = edge.locator('.svelte-flow__edge-path')
    const before = await pathLoc.getAttribute('d')
    const edgeCountBefore = await shell.locator('.svelte-flow__edge').count()

    const anchor = shell.locator('.svelte-flow__edgeupdater-target')
    const aBox = (await anchor.boundingBox())!

    // Find an empty drop point: scan a grid over the board and pick the first
    // spot comfortably clear of every node, so the release can't hit anything.
    const boardBox = (await shell.locator('.svelte-flow').boundingBox())!
    const nodeBoxes: { x: number; y: number; width: number; height: number }[] = []
    for (const n of await shell.locator('.svelte-flow__node').all()) {
      const b = await n.boundingBox()
      if (b) nodeBoxes.push(b)
    }
    const CLEARANCE = 70
    let empty: { x: number; y: number } | null = null
    outer: for (let fy = 0.15; fy <= 0.85; fy += 0.1) {
      for (let fx = 0.15; fx <= 0.85; fx += 0.1) {
        const x = boardBox.x + boardBox.width * fx
        const y = boardBox.y + boardBox.height * fy
        const clear = nodeBoxes.every(
          (b) =>
            x < b.x - CLEARANCE ||
            x > b.x + b.width + CLEARANCE ||
            y < b.y - CLEARANCE ||
            y > b.y + b.height + CLEARANCE,
        )
        if (clear) {
          empty = { x, y }
          break outer
        }
      }
    }
    expect(empty).not.toBeNull()

    await dragTo(
      page,
      aBox.x + aBox.width / 2,
      aBox.y + aBox.height / 2,
      empty!.x,
      empty!.y,
    )

    // The edge snaps back: same count, same geometry — a miss is never a delete.
    await expect(shell.locator('.svelte-flow__edge')).toHaveCount(edgeCountBefore)
    await expect(pathLoc).toHaveAttribute('d', before ?? '')
  })

  test('dragging the bend handle changes the selected edge route', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const edge = shell.locator('[data-id="e1"]')
    await clickEdgePath(page, edge)
    const pathLoc = edge.locator('.svelte-flow__edge-path')
    const before = await pathLoc.getAttribute('d')

    const bendHandle = shell.locator('.edge-bend-handle')
    await expect(bendHandle).toBeVisible({ timeout: 3_000 })
    const box = (await bendHandle.boundingBox())!

    await dragTo(
      page,
      box.x + box.width / 2,
      box.y + box.height / 2,
      box.x + box.width / 2 + 60,
      box.y + box.height / 2,
    )

    await expect(pathLoc).not.toHaveAttribute('d', before ?? '', { timeout: 3_000 })
  })
})

test.describe('Diagram delete affordance', () => {
  test('delete button appears in toolbar and is disabled without selection', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    const deleteBtn = toolbar.getByRole('button', { name: 'Delete selected' })
    await expect(deleteBtn).toBeVisible({ timeout: 5_000 })
    await expect(deleteBtn).toBeDisabled()
  })

  test('selecting a node enables the delete button', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click()

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    const deleteBtn = toolbar.getByRole('button', { name: 'Delete selected' })
    await expect(deleteBtn).toBeEnabled({ timeout: 3_000 })
  })

  test('clicking delete button removes selected node', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()
    await shell.locator('.svelte-flow__node[data-id="web"]').click()

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Delete selected' }).click()

    await expect(nodes).toHaveCount(before - 1, { timeout: 3_000 })
  })

  test('Delete/Backspace keyboard shortcut still works', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()
    await shell.locator('.svelte-flow__node[data-id="web"]').click()
    await page.keyboard.press('Delete')

    await expect(nodes).toHaveCount(before - 1, { timeout: 3_000 })
  })
})

test.describe('Diagram context menu', () => {
  test('right-clicking a node shows context menu with Delete', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click({ button: 'right' })

    const ctxMenu = page.locator('.ctx-menu')
    await expect(ctxMenu).toBeVisible({ timeout: 2_000 })
    // Node menu now offers Edit details alongside Delete
    await expect(ctxMenu).toContainText('Edit details')
    await expect(ctxMenu).toContainText('Delete')
  })

  test('right-clicking an edge shows context menu with Edit edge and Delete', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const edge = shell.locator('.svelte-flow__edge').first()
    await clickEdgePath(page, edge, 'right')

    const ctxMenu = page.locator('.ctx-menu')
    await expect(ctxMenu).toBeVisible({ timeout: 2_000 })

    // Edge editing is consolidated into the right-side drawer, so the menu mirrors
    // the node menu: a single "Edit edge" entry plus Delete.
    await expect(ctxMenu).toContainText('Edit edge')
    await expect(ctxMenu).toContainText('Delete')
  })

  test('context menu closes on Escape', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click({ button: 'right' })

    const ctxMenu = page.locator('.ctx-menu')
    await ctxMenu.waitFor({ state: 'visible', timeout: 2_000 })
    await page.keyboard.press('Escape')

    await expect(ctxMenu).toBeHidden({ timeout: 2_000 })
  })

  test('Delete from context menu removes the node', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()

    await shell.locator('.svelte-flow__node[data-id="web"]').click({ button: 'right' })
    const ctxMenu = page.locator('.ctx-menu')
    await ctxMenu.locator('[role="menuitem"]', { hasText: 'Delete' }).click()

    await expect(nodes).toHaveCount(before - 1, { timeout: 3_000 })
  })
})

test.describe('Diagram edge details drawer', () => {
  // Right-click an edge and choose "Edit edge" to open the right-side drawer.
  async function openEdgeDrawer(page: any, shell: any) {
    const edge = shell.locator('.svelte-flow__edge').first()
    await clickEdgePath(page, edge, 'right')
    const ctxMenu = page.locator('.ctx-menu')
    await ctxMenu.locator('[role="menuitem"]', { hasText: 'Edit edge' }).click()
    const drawer = shell.locator('.diagram-drawer[aria-label="Edit edge"]')
    await drawer.waitFor({ state: 'visible', timeout: 3_000 })
    return drawer
  }

  test('opens the edge drawer from the context menu', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    await expect(drawer).toContainText('Edit edge')
    // The label input is focused on open so the edge is immediately editable.
    await expect(drawer.locator('.diagram-drawer__name-input')).toBeFocused()
  })

  test('selecting an edge opens the edge drawer without grabbing focus', async ({ page }) => {
    const shell = await openDiagramShell(page)

    await clickEdgePath(page, shell.locator('.svelte-flow__edge').first())

    const drawer = shell.locator('.diagram-drawer[aria-label="Edit edge"]')
    await expect(drawer).toBeVisible({ timeout: 2_000 })
    // Plain selection (vs. an explicit "Edit edge") leaves focus on the canvas.
    await expect(drawer.locator('.diagram-drawer__name-input')).not.toBeFocused()
  })

  test('editing the label in the drawer updates the edge on canvas', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    const input = drawer.locator('.diagram-drawer__name-input')
    await input.fill('Drawer Label')

    const updatedLabel = shell.locator('.edge-label-display', { hasText: 'Drawer Label' })
    await expect(updatedLabel.first()).toBeVisible({ timeout: 3_000 })
  })

  test('changing the type updates the active segment', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    const asyncBtn = drawer.locator('.diagram-edge-seg__btn', { hasText: 'Async' })
    await asyncBtn.click()
    await expect(asyncBtn).toHaveAttribute('aria-pressed', 'true')
  })

  test('each type segment previews how its edge renders', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    // The swatch is what lets a user recognise the edge style without reading
    // the name — so each kind must render its own variant, not just a label.
    await expect(drawer.locator('.diagram-edge-seg__preview--sync')).toBeVisible()
    await expect(drawer.locator('.diagram-edge-seg__preview--async')).toBeVisible()
    await expect(drawer.locator('.diagram-edge-seg__preview--data')).toBeVisible()
  })

  test('choosing a colour recolours the edge on canvas', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    const green = drawer.locator('.diagram-edge-color__swatch[aria-label="Green"]')
    await green.click()

    // The picker reflects the selection...
    await expect(green).toHaveAttribute('aria-pressed', 'true')
    // ...and the colour is actually painted on the edge stroke (proves the
    // choice reaches the canvas, not just the control state). Computed style —
    // the engine normalises the inline hex to rgb().
    await expect(
      shell.locator('.svelte-flow__edge').first().locator('.svelte-flow__edge-path'),
    ).toHaveCSS('stroke', 'rgb(74, 222, 128)', { timeout: 3_000 })
  })

  test('picking a custom colour recolours the edge', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    // The OS colour dialog can't be driven, so set the native input directly and
    // fire `input` — the same event the picker emits on selection.
    const customInput = drawer.locator('.diagram-edge-color__custom-input')
    await customInput.evaluate((el: HTMLInputElement, value: string) => {
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, '#123456')

    // Computed style — the engine normalises the inline hex to rgb().
    await expect(
      shell.locator('.svelte-flow__edge').first().locator('.svelte-flow__edge-path'),
    ).toHaveCSS('stroke', 'rgb(18, 52, 86)', { timeout: 3_000 })
    // The custom swatch claims the active ring once an off-palette colour is set.
    await expect(
      drawer.locator('.diagram-edge-color__swatch--custom'),
    ).toHaveClass(/diagram-edge-color__swatch--active/)
  })

  test('adjusting the weight slider re-weights the edge on canvas', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    // Drive the range input directly and fire `input` — the same event a drag
    // emits. A heavier weight matters because it lets a user signal that one
    // connection carries more importance than the others.
    const slider = drawer.locator('.diagram-edge-weight__slider')
    await slider.evaluate((el: HTMLInputElement, value: string) => {
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, '3')

    // The readout reflects the choice...
    await expect(drawer.locator('.diagram-edge-weight__value')).toHaveText('3px')
    // ...and the weight is actually painted on the edge stroke (proves the
    // choice reaches the canvas, not just the control state).
    await expect(
      shell.locator('.svelte-flow__edge').first().locator('.svelte-flow__edge-path'),
    ).toHaveCSS('stroke-width', '3px', { timeout: 3_000 })
  })

  test('Escape closes the edge drawer', async ({ page }) => {
    const shell = await openDiagramShell(page)
    const drawer = await openEdgeDrawer(page, shell)

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden({ timeout: 2_000 })
  })
})
