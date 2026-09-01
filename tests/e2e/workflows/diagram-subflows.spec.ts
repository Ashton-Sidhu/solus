import { test, expect } from '../fixtures/electron-app'
import { AppPage } from '../helpers/app.page'
import { ConversationPage } from '../helpers/conversation.page'

// Mirrors openDiagramShell() from diagram-editing.spec.ts. The __MOCK_DIAGRAM__
// fixture ships a pre-built subflow: a sized "Kubernetes" group with one nested
// "Worker" child, so the nesting/detach assertions don't ride on flaky drag
// math (see tests/e2e/mock/mock-backend.ts).
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

// Drag from an absolute viewport point by a delta, in steps so xyflow's drag
// handler registers intermediate moves (a single jump can be dropped).
async function dragBy(page: any, fromX: number, fromY: number, dx: number, dy: number) {
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move(fromX + dx * 0.5, fromY + dy * 0.5, { steps: 6 })
  await page.mouse.move(fromX + dx, fromY + dy, { steps: 6 })
  await page.mouse.up()
}

test.describe('Diagram subflows — add group', () => {
  test('Add group creates a container, opens its group drawer, and applies a chosen icon', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    const groups = shell.locator('.svelte-flow__node-group')
    const before = await groups.count()

    const toolbar = shell.locator('[role="toolbar"][aria-label="Canvas controls"]')
    await toolbar.getByRole('button', { name: 'Add group' }).click()

    // A new group node appears and is selected; its drawer shows the simplified
    // "Edit group" form (label + icon only — no status/badges/metrics).
    await expect(groups).toHaveCount(before + 1)
    const drawer = shell.locator('.diagram-drawer[aria-label^="Edit group"]')
    await expect(drawer).toBeVisible({ timeout: 2_000 })
    await expect(drawer.getByText('Edit group')).toBeVisible()
    await expect(drawer.locator('select')).toHaveCount(0)

    // Pick the curated Kubernetes brand logo — the whole point of group icons.
    await drawer.locator('.icon-picker__item[aria-label="Kubernetes"]').click()

    // The new (selected) group's header renders the brand logo. Curated fallback
    // glyphs use a 16×16 viewBox; the Iconify brand logo does not, so asserting
    // on the viewBox proves the chosen icon won over the default group glyph.
    const newGroupIcon = shell
      .locator('.svelte-flow__node-group.selected .diagram-group__icon svg')
    await expect(newGroupIcon).toBeVisible()
    await expect(newGroupIcon).not.toHaveAttribute('viewBox', '0 0 16 16')
  })
})

test.describe('Diagram subflows — nesting', () => {
  test('a nested child moves when its group is dragged', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const group = shell.locator('.svelte-flow__node-group')
    const worker = shell.locator('.svelte-flow__node', { hasText: 'Worker' })
    await expect(group).toHaveCount(1)
    await expect(worker).toHaveCount(1)

    const gBox = (await group.boundingBox())!
    const wBefore = (await worker.boundingBox())!

    // Grab the group near its bottom edge (clear of the header and the child)
    // and drag it; the child must travel with it, proving the parent link.
    await dragBy(page, gBox.x + gBox.width * 0.5, gBox.y + gBox.height - 12, 90, 70)

    await expect
      .poll(async () => (await worker.boundingBox())!.x, { timeout: 3_000 })
      .toBeGreaterThan(wBefore.x + 30)
    expect((await worker.boundingBox())!.y).toBeGreaterThan(wBefore.y + 25)
  })
})

test.describe('Diagram subflows — remove from group', () => {
  test('Remove from group detaches the child so it no longer follows the group', async ({
    page,
  }) => {
    const shell = await openDiagramShell(page)

    const group = shell.locator('.svelte-flow__node-group')
    const worker = shell.locator('.svelte-flow__node', { hasText: 'Worker' })

    // Detach via the child's context menu — only nested nodes get this item.
    await worker.click({ button: 'right' })
    await page
      .locator('.ctx-menu [role="menuitem"]', { hasText: 'Remove from group' })
      .click()

    const wBefore = (await worker.boundingBox())!
    const gBox = (await group.boundingBox())!

    // After detaching, dragging the group must leave the (now free) child put.
    // Drag up-left, toward the canvas centre: dragging toward the board edge
    // would trigger xyflow's auto-pan, shifting every node's SCREEN position
    // and breaking the stay-put assertion below.
    await dragBy(page, gBox.x + gBox.width * 0.5, gBox.y + gBox.height - 12, -90, -70)

    // Give the drag a beat to settle, then assert the child barely moved.
    await page.waitForTimeout(300)
    const wAfter = (await worker.boundingBox())!
    expect(Math.abs(wAfter.x - wBefore.x)).toBeLessThan(20)
    expect(Math.abs(wAfter.y - wBefore.y)).toBeLessThan(20)
  })

  test('the Remove from group item is absent for a free node', async ({ page }) => {
    const shell = await openDiagramShell(page)

    // The "Database" node lives on the free canvas — no group membership.
    await shell.locator('.svelte-flow__node', { hasText: 'Database' }).click({ button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 2_000 })
    await expect(
      page.locator('.ctx-menu [role="menuitem"]', { hasText: 'Remove from group' }),
    ).toHaveCount(0)
  })
})

test.describe('Diagram subflows — delete detaches', () => {
  test('deleting a group keeps its children on the canvas', async ({ page }) => {
    const shell = await openDiagramShell(page)

    const worker = shell.locator('.svelte-flow__node', { hasText: 'Worker' })
    await expect(worker).toHaveCount(1)

    // Select the group and delete it; the child survives as a free node.
    // Click between the header pill and the nested Worker card — the group's
    // centre is covered by the child, which would swallow the click.
    await shell.locator('.svelte-flow__node-group').click({ position: { x: 16, y: 60 } })
    await page.keyboard.press('Backspace')

    await expect(shell.locator('.svelte-flow__node-group')).toHaveCount(0, { timeout: 3_000 })
    await expect(worker).toHaveCount(1)
  })
})
