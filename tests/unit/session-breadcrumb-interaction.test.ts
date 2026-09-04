import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The breadcrumb band's three menus are clicked open, dismissed by a click
// elsewhere or Esc, and never fight the window-drag region. Each test pins one
// of those rules against the component source, because the rule lives in the
// markup's handlers rather than in a function a unit test could call.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const band = readFileSync(`${UI}components/conversation/SessionBreadcrumb.svelte`, 'utf8')

/** Only the band's own markup: the script above it declares the rules, the
 *  markup is where a hover or focus handler would sneak back in. */
const markup = band.slice(band.indexOf('</script>'))

describe('the breadcrumb band opens its menus on click', () => {
  test('no crumb opens or closes a menu from hover or focus', () => {
    // WHY: a hover-open menu closes the moment the pointer crosses the drag
    // region between crumbs, and a focus-open one reopens on the mousedown of
    // the click that meant to close it. Click is the only way in.
    expect(markup).not.toMatch(/onmouseenter=/)
    expect(markup).not.toMatch(/onmouseleave=/)
    expect(markup).not.toMatch(/onfocus=\{[^}]*menu/)
  })

  test('each crumb toggles its own menu and says it owns one', () => {
    expect(markup).toContain('onclick={() => toggleMenu("project")}')
    expect(markup).toContain('onclick={toggleTaskPicker}')
    expect(markup).toContain('onclick={() => toggleMenu("session")}')
    expect(markup.match(/aria-haspopup="menu"/g)?.length).toBeGreaterThanOrEqual(3)
  })

  test('a click outside the band or Esc closes the open menu', () => {
    // WHY: with hover gone, nothing else would ever close a menu. Both
    // listeners run in the capture phase so a click on another crumb still
    // opens that crumb in the same press, and Esc does not reach the page's
    // own handler and close the pane underneath.
    expect(band).toContain('document.addEventListener("pointerdown", onPointerDown, true)')
    expect(band).toContain('document.addEventListener("keydown", onKeydown, true)')
    expect(band).toContain('bandEl?.contains(event.target)')
  })

  test('a right-click closes the dropdown before the context menu opens', () => {
    // WHY: the context menu is portalled above the band; leaving the dropdown
    // open under it would let a stray click select a row through the gap.
    const openers = band.slice(
      band.indexOf('function openTaskContextMenu('),
      band.indexOf('function selectTask('),
    )
    const closes = openers.match(/menu = null;/g) ?? []
    expect(closes).toHaveLength(3)
  })
})

describe('the breadcrumb band and the window-drag region', () => {
  test('the whole crumb opts out of the drag region, not only its buttons', () => {
    // WHY: on the mac editor the band drags the window. Separators, gaps, and
    // item edges inside the crumb would otherwise swallow a click that landed
    // a few pixels off a button.
    expect(markup).toMatch(/<Breadcrumb\.Root[\s\S]*?class="no-drag /)
  })
})
