import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'
import { KeyboardShortcutsPage } from '../helpers/keyboard-shortcuts.page'

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

test.describe('Diagram editing — add node', () => {
  test('Add node selects it and opens the editable drawer', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Add node' }).click()

    // Node count grows, the new node is selected, and its details drawer opens
    await expect(nodes).toHaveCount(before + 1)
    await expect(shell.locator('.svelte-flow__node.selected')).toHaveCount(1)
    await expect(shell.locator('.diagram-drawer')).toBeVisible({ timeout: 2_000 })
  })
})

test.describe('Diagram editing — drawer edits', () => {
  test('picking a curated icon in the drawer updates the node icon', async ({ page }) => {
    const shell = await openDiagramShell(page)

    // Open the drawer for the first node via the context menu
    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click({ button: 'right' })
    await page.locator('.ctx-menu [role="menuitem"]', { hasText: 'Edit details' }).click()

    const drawer = shell.locator('.diagram-drawer')
    await expect(drawer).toBeVisible({ timeout: 2_000 })

    // The IconPicker curated grid is rendered; click the "Queue" icon button
    const queueBtn = drawer.locator('.icon-picker__item[aria-label="Queue"]')
    await expect(queueBtn).toBeVisible({ timeout: 2_000 })
    await queueBtn.click()

    // The node's icon area should now render the queue SVG glyph (16×16 viewBox)
    const iconSvg = node.locator('.diagram-node__icon svg')
    await expect(iconSvg).toBeVisible()
    await expect(iconSvg).toHaveAttribute('viewBox', '0 0 16 16')

    // No node has a status in the mock — setting one renders a status dot
    await expect(shell.locator('.diagram-node__status-dot')).toHaveCount(0)
    await drawer.locator('select').first().selectOption('error')
    await expect(shell.locator('.diagram-node__status-dot')).toHaveCount(1)
  })

  test('searching the icon picker surfaces brand icons and applies the selection', async ({ page }) => {
    // Deterministic, offline: stub the Iconify search API with bundled `logos:*`
    // names so the result grid renders from the local collection (no network).
    await page.route('**/api.iconify.design/search**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ icons: ['logos:aws', 'logos:aws-s3'], total: 2 }),
      }),
    )

    const shell = await openDiagramShell(page)

    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click({ button: 'right' })
    await page.locator('.ctx-menu [role="menuitem"]', { hasText: 'Edit details' }).click()

    const drawer = shell.locator('.diagram-drawer')
    await expect(drawer).toBeVisible({ timeout: 2_000 })

    // Typing a brand term runs the debounced search and shows matching icons —
    // the whole point: "S3"/"AWS" should surface real brand logos.
    await drawer.locator('.icon-picker__input').fill('aws')

    const results = drawer.locator('.icon-picker__grid[aria-label="Search results"] .icon-picker__item')
    await expect(results.first()).toBeVisible({ timeout: 2_000 })
    expect(await results.count()).toBeGreaterThan(0)

    // Selecting a result applies it: the node icon renders the brand logo SVG.
    await results.first().click()
    await expect(node.locator('.diagram-node__icon svg')).toBeVisible()
  })
})

test.describe('Diagram editing — clipboard & selection', () => {
  test('Cmd/Ctrl+A selects every node', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const total = await nodes.count()

    await shell.locator('.svelte-flow__node[data-id="web"]').click()
    await page.keyboard.press('ControlOrMeta+a')

    await expect(shell.locator('.svelte-flow__node.selected')).toHaveCount(total)
  })

  test('copy then paste increases the node count', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()

    await shell.locator('.svelte-flow__node[data-id="web"]').click()
    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('ControlOrMeta+v')

    await expect(nodes).toHaveCount(before + 1, { timeout: 3_000 })
  })
})

test.describe('Diagram editing — selection opens drawer', () => {
  test('selecting a node opens its drawer but keeps keyboard on the canvas', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()
    await shell.locator('.svelte-flow__node[data-id="web"]').click()

    // The side menu pops up for the selected node...
    const drawer = shell.locator('.diagram-drawer[aria-label^="Edit node"]')
    await expect(drawer).toBeVisible({ timeout: 2_000 })
    // ...but it must NOT grab focus, or canvas shortcuts would break. Proof:
    // Delete still removes the selected node instead of editing the label.
    await expect(drawer.locator('.diagram-drawer__name-input')).not.toBeFocused()
    await page.keyboard.press('Delete')
    await expect(nodes).toHaveCount(before - 1, { timeout: 3_000 })
  })

  test('clicking the empty canvas closes the drawer', async ({ page }) => {
    const shell = await openDiagramShell(page)

    await shell.locator('.svelte-flow__node[data-id="web"]').click()
    const drawer = shell.locator('.diagram-drawer[aria-label^="Edit node"]')
    await expect(drawer).toBeVisible({ timeout: 2_000 })

    // Deselecting (clicking the pane) dismisses the selection-driven menu.
    await shell.locator('.svelte-flow__pane').click({ position: { x: 6, y: 6 } })
    await expect(drawer).toBeHidden({ timeout: 2_000 })
  })
})

test.describe('Diagram editing — search', () => {
  test('Cmd/Ctrl+F search dims non-matching nodes', async ({ page }) => {
    const shell = await openDiagramShell(page)

    await shell.locator('.svelte-flow__node[data-id="web"]').click()
    await page.keyboard.press('ControlOrMeta+f')

    const search = shell.locator('.diagram-search__input')
    await expect(search).toBeVisible({ timeout: 2_000 })
    await search.fill('Database')

    // Non-matching nodes are dimmed; the matching one is not
    await expect(shell.locator('.diagram-node--dimmed').first()).toBeVisible({ timeout: 2_000 })
    const dimmed = await shell.locator('.diagram-node--dimmed').count()
    expect(dimmed).toBeGreaterThan(0)
  })
})

test.describe('Diagram editing — resize handles', () => {
  test('resize handles become visible when a node is selected', async ({ page }) => {
    const shell = await openDiagramShell(page)

    await shell.locator('.svelte-flow__node[data-id="web"]').click()

    // Handles exist always but are opacity:0 until the node is selected/hovered.
    // Poll — the reveal is animated (0.12s opacity transition).
    await expect
      .poll(
        async () =>
          Number(
            await shell
              .locator('.svelte-flow__node.selected .node-resize-handle')
              .first()
              .evaluate((el: Element) => getComputedStyle(el).opacity),
          ),
        { timeout: 2_000 },
      )
      .toBeGreaterThan(0.5)
  })
})

test.describe('Diagram editing — export & minimap', () => {
  test('export menu exposes image and text options', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Export diagram' }).click()

    const menu = page.locator('.export-menu__dropdown')
    await expect(menu).toBeVisible({ timeout: 2_000 })
    await expect(menu).toContainText('Save as PNG')
    await expect(menu).toContainText('Copy as JSON')
    await expect(menu).toContainText('Copy as Mermaid')
  })

  test('Copy as JSON writes serialized diagram to the clipboard', async ({ page, electronApp }) => {
    const shell = await openDiagramShell(page)

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Export diagram' }).click()
    await page.locator('.export-menu__dropdown [role="menuitem"]', { hasText: 'Copy as JSON' }).click()

    // Read the system clipboard from the main process — reliable in Electron
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 3_000 })
      .toContain('"nodes"')
  })

  test('minimap toggle hides and shows the minimap', async ({ page }) => {
    const shell = await openDiagramShell(page)

    await expect(shell.locator('.diagram-minimap')).toBeVisible()

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Hide minimap' }).click()
    await expect(shell.locator('.diagram-minimap')).toHaveCount(0)

    await toolbar.getByRole('button', { name: 'Show minimap' }).click()
    await expect(shell.locator('.diagram-minimap')).toBeVisible()
  })
})

test.describe('Diagram editing — layout options', () => {
  test('layout menu exposes the flow directions and re-arranges the graph', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Arrange layout' }).click()

    const menu = page.locator('.layout-menu__dropdown')
    await expect(menu).toBeVisible({ timeout: 2_000 })
    await expect(menu).toContainText('Horizontal')
    await expect(menu).toContainText('Vertical')

    // Capture the spread of node x-positions before switching to a vertical
    // layout — Vertical should collapse the horizontal spread and stack nodes.
    const xSpread = async () =>
      shell.locator('.svelte-flow__node').evaluateAll((els: Element[]) => {
        const xs = els.map((el) => (el as HTMLElement).getBoundingClientRect().left)
        return Math.max(...xs) - Math.min(...xs)
      })

    const before = await xSpread()
    await menu.getByRole('menuitemradio', { name: 'Vertical' }).click()

    // Vertical flow stacks nodes, so the horizontal spread shrinks.
    await expect.poll(xSpread, { timeout: 3_000 }).toBeLessThan(before)

    // The chosen direction is now marked active in the reopened menu.
    await toolbar.getByRole('button', { name: 'Arrange layout' }).click()
    await expect(
      page.locator('.layout-menu__dropdown [role="menuitemradio"][aria-checked="true"]'),
    ).toHaveText(/Vertical/)
  })
})

test.describe('Diagram icons — brand logos', () => {
  test('a node with an Iconify name renders the real brand logo, not a fallback glyph', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    // The mock "Database" node carries icon: 'logos:postgresql'. Iconify resolves
    // it from the bundled `logos` collection and renders a coloured SVG. The
    // abstract fallback glyphs use a 16×16 viewBox — a real brand logo does not,
    // so asserting on the viewBox proves the brand icon won (not the fallback).
    const dbNode = shell.locator('.svelte-flow__node', { hasText: 'Database' })
    const iconSvg = dbNode.locator('.diagram-node__icon svg')

    await expect(iconSvg).toBeVisible()
    await expect(iconSvg).not.toHaveAttribute('viewBox', '0 0 16 16')
  })
})

test.describe('Diagram editing — keyboard shortcuts', () => {
  /**
   * Intent test (Rule 6): the diagram's canvas keys used to be a private,
   * undiscoverable keydown handler. The whole point of routing them through the
   * shared manifest is discoverability — with a diagram open, its scope is
   * mounted, so the global panel MUST surface "Diagram" as an active section
   * (ranked above Global) listing the real commands. If this regresses, the
   * shortcuts become invisible again, which is exactly the bug we fixed.
   */
  test('diagram shortcuts surface as an active section in the global panel', async ({ page }) => {
    await openDiagramShell(page)

    const shortcuts = new KeyboardShortcutsPage(page)
    await shortcuts.open()
    await shortcuts.waitForOpen()

    const texts = await shortcuts.scopeHeadings().allTextContents()
    const diagramIdx = texts.findIndex((t) => t.trim() === 'Diagram')
    const globalIdx = texts.findIndex((t) => t.trim() === 'Global')
    expect(diagramIdx).toBeGreaterThanOrEqual(0)
    expect(globalIdx).toBeGreaterThan(diagramIdx)

    // The actual canvas commands are listed, not just the section header.
    await expect(shortcuts.row('Add node')).toBeVisible()
    await expect(shortcuts.row('Select all')).toBeVisible()
    await expect(shortcuts.row('Nudge up')).toBeVisible()
  })

  /**
   * Regression (Rule 6): ⌥N is bound to "Add node" in the diagram scope, which
   * is only active while focus lives inside the shell — so if the shell doesn't
   * grab focus on mount, the very first ⌥N falls through to no active binding and
   * nothing happens. This asserts the shell is focused on open so ⌥N adds a node
   * without any prior click.
   */
  test('Alt+N adds a node immediately after opening, without clicking first', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const nodes = shell.locator('.svelte-flow__node')
    const before = await nodes.count()

    // No click — focus must already be inside the shell from mount.
    await page.keyboard.press('Alt+n')

    await expect(nodes).toHaveCount(before + 1)
    await expect(shell.locator('.diagram-drawer')).toBeVisible({ timeout: 2_000 })
  })

  test('Arrow keys nudge the selected node along the canvas', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click()
    await expect(node).toHaveClass(/selected/)

    const left = async () => (await node.boundingBox())!.x
    const before = await left()

    await page.keyboard.press('ArrowRight')

    // The nudge now travels through the central dispatcher; the node still moves.
    await expect.poll(left, { timeout: 3_000 }).toBeGreaterThan(before)
  })

  test('Escape peels back the node drawer without closing the diagram', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const node = shell.locator('.svelte-flow__node[data-id="web"]')
    await node.click()
    const drawer = shell.locator('.diagram-drawer[aria-label^="Edit node"]')
    await expect(drawer).toBeVisible({ timeout: 2_000 })

    await page.keyboard.press('Escape')

    // dismiss() unwinds the most specific overlay first — the drawer closes but
    // the canvas stays open, so one Escape never throws away the whole view.
    await expect(drawer).toBeHidden({ timeout: 2_000 })
    await expect(shell).toBeVisible()
  })
})

test.describe('Diagram shell — header close button', () => {
  test('header renders an icon close button and clicking it dismisses the shell', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    // The standardised header must expose an icon ✕ button (mirrors doc-shell-close)
    const closeBtn = shell.getByTestId('diagram-shell-close')
    await expect(closeBtn).toBeVisible()

    await closeBtn.click()

    // The diagram shell is gone after closing
    await expect(shell).toBeHidden({ timeout: 3_000 })
  })
})
