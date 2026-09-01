import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEVICE_PRESETS } from '@solus/contracts/browser-types'
import { describe, expect, test } from 'bun:test'

/**
 * A `<webview>` is a custom element that wraps an `<iframe>` in its shadow root,
 * and Electron's own `display: flex` is what makes that iframe fill the tag.
 * Overriding the display mode leaves the iframe at a replaced element's default
 * 150px height: the guest paints a thin band of the page at the top of the
 * stage and the rest stays the frame's white background — the bug looked like
 * "a big white square", not like a broken layout rule.
 *
 * This is asserted against the markup because there is nothing else to assert
 * it against: the rule lives entirely in the class list handed to the tag.
 */
const layerSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserWebviewLayer.svelte',
  ),
  'utf8',
)

function guestClassList(): string {
  // `<webview\s` rather than `<webview`, so the prose above the tag — which
  // names `<webview>` as the thing the rule is about — is not mistaken for it.
  const tag = layerSource.slice(layerSource.search(/<webview\s/))
  const match = /class="([^"]*)"/.exec(tag)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

describe('the browser guest element', () => {
  test('keeps the flex layout its inner iframe sizes against', () => {
    expect(guestClassList().split(/\s+/)).toContain('flex')
  })

  test('never declares another display mode', () => {
    const classes = guestClassList().split(/\s+/)
    for (const forbidden of ['block', 'inline-block', 'grid', 'contents', 'hidden']) {
      expect(classes).not.toContain(forbidden)
    }
  })

  test('is layered per guest so a maximized pane cannot cover its image', () => {
    // WHY: one z-index on a full-window parent traps every guest below the
    // fixed maximized pane. Each guest must take the layer from its own slot.
    expect(layerSource).not.toContain('fixed inset-0 z-10')
    expect(layerSource).toContain('placement.layer === "maximized" ? 10041 : 10')
  })

  test('stays mounted when its pane is temporarily hidden', () => {
    // WHY: the visible rectangle disappears when the browser hotkey hides the
    // pane. Using that rectangle as the mount condition destroys the webview,
    // detaches its surface, and reloads the page on the next show.
    expect(layerSource).toContain('nativeSurfaces.mountedKeys.has(key)')
    expect(layerSource).not.toContain('nativeSurfaces.rects.has(key)')
  })
})

/**
 * Which surface a client shows is the client's own fact, not the host's. A
 * desktop client teleports a native `<webview>` over the stage; every other
 * client streams the page onto a canvas. Deciding that from the host's
 * page.problem instead left web and mobile with a blank rectangle once the
 * headless host stopped setting `no-surface` — the host was rendering the page
 * perfectly well for an agent, and the client just had to paint it.
 */
const stageSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserStage.svelte',
  ),
  'utf8',
)

const paneSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserPane.svelte',
  ),
  'utf8',
)

describe('the browser stage', () => {
  test('streams the page where no native surface can host it', () => {
    // The P2 win: web and mobile see the page instead of being told to open the
    // desktop app. The streamed surface renders when `usesNativeSurface` is false.
    expect(stageSource).toContain('<StreamedSurface')
  })

  test('claims a visible native slot before the host has attached it', () => {
    // WHY: `hostKind` is none before the webview handover. If that state blocks
    // the slot claim, the root layer never mounts the webview that can change it.
    const claim = stageSource.slice(
      stageSource.indexOf('const node = host'),
      stageSource.indexOf('presentation = nativeSurfaces.claimPresentation(pageKey)'),
    )
    expect(claim).not.toContain('nothingRenders')
  })
})

/**
 * A guest is mounted blank so the host can attach CDP and apply emulation before
 * the real page loads — the page then lays out once, at the size the user chose,
 * instead of laying out at the window's size and reflowing when the metrics
 * override lands mid-load. Two things follow, and both live in this markup.
 */
describe('the browser guest load path', () => {
  test('mounts blank rather than at the page address', () => {
    // WHY: an `src` of the real URL starts fetching immediately, before the host
    // can emulate — which is the reflow this ordering exists to remove.
    const tag = layerSource.slice(layerSource.search(/<webview\s/))
    const src = /src=\{([^}]*)\}/.exec(tag)?.[1] ?? ''
    expect(src).toContain('BROWSER_BLANK_URL')
  })

  test('veils a guest on first paint, not on every load', () => {
    // WHY: keying the veil on the page's load state would flash a blank
    // rectangle over a page that is still perfectly visible on every in-page
    // navigation. It is owed only while the guest has never painted.
    expect(layerSource).toContain('nativeSurfaces.hasPainted(key)')
    const veil = layerSource.slice(layerSource.indexOf('hasPainted(key)'))
    expect(veil).not.toContain('loadState !==')
  })
})

/**
 * A pane's floor is 25% of the workspace split, and on a phone the browser pane
 * is the whole screen at 390px. The toolbar therefore has to declare what
 * survives at its narrowest rather than letting flexbox arbitrate — an
 * arbitrated row pushes its trailing controls past the pane edge, where an
 * ancestor's `overflow-hidden` cuts them off silently.
 */
const toolbarSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserToolbar.svelte',
  ),
  'utf8',
)
const captureButtonSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserCaptureButton.svelte',
  ),
  'utf8',
)
const targetPickerSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserTargetPicker.svelte',
  ),
  'utf8',
)

describe('the browser chrome before a page opens', () => {
  test('keeps the target picker in place until the selected page is active', () => {
    // WHY: the page-changed event can reach the renderer before browserOpen
    // returns. Dismissing the picker at click time exposes the previous page (or
    // a half-created page strip) for one render before the selected page opens.
    const openBrowser = paneSource.slice(
      paneSource.indexOf('function openBrowser'),
      paneSource.indexOf('function openTarget'),
    )
    expect(openBrowser).toContain('openingPageKey = key')
    expect(openBrowser).not.toContain('choosingTarget = false')
    expect(paneSource).toContain(
      'pages.length && (!isOpeningTarget || hadPageBeforeOpen)',
    )
  })

  test('loads a native guest offscreen before replacing the target picker', () => {
    // WHY: after the open RPC returns, attaching and navigating the native guest
    // takes another frame. Showing the stage during that gap flashes its blank
    // guest or load veil. A clear slot mounts the guest parked; the picker yields
    // only after that same guest reports ready or failed.
    expect(paneSource).toContain('nativeSurfaces.mount(key)')
    expect(paneSource).toContain('const surfacePhase = nativeSurfaces.phaseOf(key)')
    expect(paneSource).toContain('surfacePhase === "ready"')
    expect(paneSource).toContain(
      'entry && activeKey && !choosingTarget && !isOpeningTarget',
    )
  })

  test('warms every local native page while the pane is visible', () => {
    // WHY: mounting only the selected page makes the first selection of every
    // existing page pay for guest creation, emulation, and a full navigation.
    const preload = paneSource.slice(
      paneSource.indexOf('Warm every local native page'),
      paneSource.indexOf('/** True while the picker'),
    )
    expect(preload).toContain('if (!surfaceVisible) return')
    expect(preload).toContain('for (const candidate of pages)')
    expect(preload).toContain('nativeSurfaces.mount(')
    expect(preload).toContain('shouldUseNativeBrowser(')
  })

  test('keeps the address bar above the target offers', () => {
    // WHY: choosing a page is still a browser state. Moving URL entry into the
    // centered empty-state card makes the browser chrome disappear exactly
    // when the user needs it to go somewhere new.
    const address = targetPickerSource.indexOf('aria-label="Browser address"')
    const offers = targetPickerSource.indexOf('Running dev servers')
    expect(address).toBeGreaterThan(0)
    expect(address).toBeLessThan(offers)
    expect(targetPickerSource).not.toContain('Or type a URL')
  })

  test('gives the address all space left by the browser controls', () => {
    // WHY: a fixed-width URL field leaves dead space in a maximized pane and
    // truncates the one value the browser must always show.
    const chrome = targetPickerSource.slice(
      targetPickerSource.indexOf('@container/toolbar'),
      targetPickerSource.indexOf('</form>'),
    )
    expect(chrome).toMatch(/class="flex h-7 min-w-0 flex-1 items-center/)
    expect(chrome).not.toMatch(/max-w-[\d.]+/)
  })

  test('focuses and normalizes the address on a new page', () => {
    // WHY: after `+`, typing is the next natural action, and a public host such
    // as twitter.com must take the same HTTPS-defaulting path as an open page.
    expect(targetPickerSource).toContain('autofocus')
    expect(targetPickerSource).toContain('navigableAddress(manualUrl)')
  })
})

describe('the browser toolbar at its narrowest', () => {
  test('gives browser controls a visible tooltip', () => {
    // WHY: native title text is delayed and unreliable in Electron. Use the
    // shared visible tooltip surface, above the teleported browser webview.
    expect(toolbarSource).toContain('import * as TooltipUI')
    expect(toolbarSource).toContain('value="Go back"')
    expect(toolbarSource).toContain('value="Go forward"')
    expect(toolbarSource).toContain('value="Reload browser"')
    expect(toolbarSource).toContain('value="Edit browser address"')
    expect(toolbarSource).toContain(
      'value="Clear browser data — signs this project\'s browser pages out"',
    )
    expect(toolbarSource).toContain('class="z-[10050]"')
    expect(toolbarSource).toContain('side="bottom"')
    expect(toolbarSource).not.toContain('title="Go back"')
    expect(captureButtonSource).toContain('import * as TooltipUI')
    expect(captureButtonSource).toContain(
      'value="Capture this page — attach it to a task or pull request"',
    )
    expect(targetPickerSource).toContain('value="Scan again"')
  })

  test('declares its ladder against its own container, never the window', () => {
    // WHY: the pane is not the window. A window-width read looks right on a
    // monitor and wrong the moment a companion pane opens.
    expect(toolbarSource).toContain('@container/toolbar')
    expect(toolbarSource).not.toMatch(/\b(sm|md|lg|xl):/)
  })

  test('never hides the address or the size', () => {
    // WHY: these two are the floor. A browser surface that cannot say where the
    // page is or what size it is being rendered at has stopped being evidence.
    const addressField = toolbarSource.slice(
      toolbarSource.indexOf('Browser address:'),
      toolbarSource.indexOf('</button>', toolbarSource.indexOf('Browser address:')),
    )
    expect(addressField).not.toContain('/toolbar:hidden')

    const chip = /<BrowserViewportChip[^>]*>/.exec(toolbarSource)?.[0] ?? ''
    expect(chip).not.toBe('')
    expect(chip).not.toContain('hidden')
  })

  test('drops controls in one declared order, not wherever flexbox runs out', () => {
    // WHY: a ladder is only a ladder if every rung is a distinct width. Two
    // controls sharing a rung is the arbitration this exists to replace.
    const rungs = [...toolbarSource.matchAll(/@max-\[([\d.]+)rem\]\/toolbar:hidden/g)].map(
      (match) => Number(match[1]),
    )
    expect(rungs.length).toBeGreaterThan(0)
    expect(new Set(rungs).size).toBeGreaterThan(1)
  })
})

describe('where the browser toolbar puts its tools', () => {
  test('lets the address use all space left by the tool cluster', () => {
    // WHY: a fixed ceiling leaves a wide dead strip when the pane is maximized.
    // The tools already have fixed intrinsic widths, so `flex-1` gives the
    // address exactly the remaining room on every pane size.
    expect(toolbarSource).not.toContain('max-w-140')
    expect(toolbarSource).not.toContain('<span class="flex-1"></span>')
    expect(toolbarSource).toMatch(/class="flex h-7 min-w-0 flex-1 items-center/)
  })

  test('offers the way out to a real browser only where the address means this machine', () => {
    // WHY: the guest is not always rendered here. From a phone, handing
    // `localhost:5173` to the phone's own browser opens nothing — so the control
    // is gated on the same fact as DevTools rather than always shown.
    expect(toolbarSource).toContain('{#if onOpenExternal}')
    expect(toolbarSource).toContain('Open in your default browser')
  })
})

describe('native browser input', () => {
  test('makes the whole on-screen guest layer interactive', () => {
    // WHY: Electron routes a `<webview>` through an out-of-process iframe.
    // Leaving its fixed ancestor permanently `pointer-events-none` and trying
    // to opt only a child back in can paint the page while dropping its wheel
    // input. The shell is one state: interactive on screen, inert when parked.
    expect(webviewLayerSource).toContain(
      'class:pointer-events-auto={placement.onScreen && !stageDrag.active}',
    )
    expect(webviewLayerSource).toContain(
      'class:pointer-events-none={!placement.onScreen || stageDrag.active}',
    )
    expect(webviewLayerSource).not.toContain('class="pointer-events-none fixed"')
  })
})

/**
 * A failed load is a state the user can act on. The frame is the only surface
 * that states it, so it is the only place that can carry the action.
 */
describe('the browser stage on a page that will not load', () => {
  test('offers a retry rather than only a promise to poll', () => {
    // WHY: the page does re-reload itself once the port answers, but a user who
    // has just started the server should not have to wait out a poll to find
    // out whether it worked.
    expect(stageSource).toContain('onReload')
    expect(stageSource).toMatch(/onclick=\{onReload\}>Retry/)
  })

  test('does not offer a plain retry to a guest that died', () => {
    // WHY: a crashed `<webview>` cannot be reloaded in place — it needs a new
    // element, which is what "Reload browser" does. Asking the dead guest to
    // navigate again would do nothing and say it did something.
    const retryGuard = stageSource.indexOf('page.problem.kind !== "surface-crashed"')
    expect(retryGuard).toBeGreaterThan(0)
  })
})

/**
 * Annotating must not reshape the thing being annotated.
 *
 * The tool row sits under the frame — the desktop guest is painted over the
 * frame by a fixed layer at app root, so a bar drawn on top of the page is
 * invisible exactly where it is needed — which makes the row's height the
 * frame's height. It used to carry the list of marks too, so every mark the
 * user made shortened the page they were marking: the stage re-fit, the picture
 * re-scaled, and the target moved under the pointer mid-session.
 */
const webviewLayerSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserWebviewLayer.svelte',
  ),
  'utf8',
)
const annotationBarSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserAnnotationBar.svelte',
  ),
  'utf8',
)
describe('the annotation surfaces', () => {
  test('gives the tool row a fixed height', () => {
    // WHY: any height that follows content is a height that changes as marks
    // accumulate, and the stage below it re-fits the page to whatever is left.
    expect(annotationBarSource).toMatch(/class="[^"]*\bh-10\b[^"]*shrink-0/)
  })

  test('keeps the list of marks out of the tool row', () => {
    // WHY: this is the thing that grew. The bar states a count and nothing that
    // can wrap, scroll, or stack.
    expect(annotationBarSource).not.toContain('{#each annotations')
    expect(annotationBarSource).not.toContain('annotationState')
  })

  test('offers only the current annotation tools', () => {
    // WHY: pin and arrow were duplicate ways to point, and comments belong in
    // the mark's popup rather than in a separate text mark. Box is now a
    // marquee that selects the elements inside it; Clear stays the reverse
    // state without leaving an erase tool armed over the page.
    for (const tool of ['select', 'pick', 'draw', 'region']) {
      expect(annotationBarSource).toContain(`id: "${tool}"`)
    }
    for (const removed of ['pin', 'arrow', 'text', 'erase']) {
      expect(annotationBarSource).not.toContain(`id: "${removed}"`)
    }
    expect(annotationBarSource).toContain('select every element fully inside it')
  })

  test('blocks the page while an annotation comment is open', () => {
    // WHY: the snippet positions its own controls in the frame's coordinate
    // space. It is normally click-through so a tool can collect marks, but the
    // comment popup must own the frame or Electron continues sending hover input
    // to the guest element behind it.
    expect(stageSource).toContain(
      'class:pointer-events-auto={annotationBlocksSurface}',
    )
    expect(stageSource).toContain(
      'class:pointer-events-none={!annotationBlocksSurface}',
    )
    expect(webviewLayerSource).toContain(
      'class:pointer-events-auto={blocksSurface}',
    )
    expect(webviewLayerSource).toContain(
      'class:pointer-events-none={!blocksSurface}',
    )
    expect(webviewLayerSource).toContain('browserOverlays.blocking.has(key)')
    // Both hand the snippet the frame's scale so a mark-anchored control can
    // place itself.
    expect(stageSource).toContain('@render annotation(fit.scale)')
    expect(webviewLayerSource).toContain('@render overlay?.(placement.scale)')
    expect(paneSource).toContain(
      'annotationBlocksSurface={Boolean(commentingMarkId)}',
    )
  })

  test('keeps the native pill outside the guest clipping frame', () => {
    // WHY: the guest must be clipped to the stage, but the pill's rounded
    // outline and shadow must not be. One clipping wrapper around both cuts the
    // pill edge and exposes that wrapper's square white background behind it.
    expect(webviewLayerSource).toMatch(
      /class="fixed"[\s\S]*?class="absolute inset-0 overflow-hidden rounded-md bg-white shadow-sm"/,
    )
    expect(webviewLayerSource).not.toContain(
      'pointer-events-none fixed overflow-hidden rounded-md bg-white shadow-sm',
    )
    expect(webviewLayerSource).not.toContain(
      'pointer-events-auto max-w-full overflow-x-auto',
    )
  })

  test('mounts the pill in the app-root layer when a native guest owns the frame', () => {
    // WHY: a `<webview>` lives in a fixed layer at app root and paints over this
    // pane whatever z-index the stage claims — and the pane cannot escape
    // upward, because WorkspaceBody transforms its columns while they animate,
    // which makes `position: fixed` inside a pane relative to the column. So the
    // stage hands the snippet to that layer, which renders it beside the guest.
    // A `<webview>` is ordinary DOM, which is why that paints over it and why
    // Solus uses one rather than a WebContentsView.
    expect(stageSource).toContain(
      'browserOverlays.set(pageKey, pill, annotationBlocksSurface)',
    )
    expect(stageSource).toMatch(/\{#if annotation && !usesNativeSurface\}/)
    expect(webviewLayerSource).toContain('browserOverlays.snippets.has(key)')
  })

  test('keeps the full canvas when annotations are open', () => {
    // WHY: annotation context now lives in the active composer. Any `notes`
    // branch or rail padding would bring back the white side sheet and shrink
    // the page while the user is marking it.
    expect(stageSource).not.toContain('{#if notes}')
    expect(stageSource).not.toContain('@min-[38rem]/stage:pr-75')
    expect(stageSource).not.toContain('@max-[38rem]/stage:pb-56')
  })

})

/**
 * The size picker. Every preset has to be reachable, and every label in it has
 * to step between the laptop and desktop rungs with the rest of the workspace.
 */
const chipSource = readFileSync(
  join(
    import.meta.dir,
    '../../packages/workspace-ui/src/components/browser/BrowserViewportChip.svelte',
  ),
  'utf8',
)

const BROWSER_DIR = join(
  import.meta.dir,
  '../../packages/workspace-ui/src/components/browser',
)

describe('the viewport picker', () => {
  test('offers every preset the catalog declares', () => {
    // WHY: the list is generated from DEVICE_PRESETS, so the only way to lose
    // one is to filter or cap the list. It renders all three groups and nothing
    // narrows what goes into them.
    expect(DEVICE_PRESETS).toHaveLength(16)
    expect(chipSource).toContain('DEVICE_PRESETS.filter((preset) => preset.group === group)')
    expect(chipSource).toContain("const GROUPS = ['phone', 'tablet', 'desktop'] as const".replace(/'/g, '"'))
  })

  test('scrolls the sheet rather than a box inside it', () => {
    // WHY: a nested `max-h` scroller put nine of the fifteen presets behind an
    // inner scrollbar that reads as the list simply ending. One scroll, on the
    // popover, keeps the whole catalog in one gesture.
    expect(chipSource).toContain('max-h-[calc(100vh-8rem)]')
    expect(chipSource).not.toContain('max-h-56')
  })

  test('keeps exact size and rotate controls', () => {
    // WHY: a breakpoint is often an exact number. The picker must keep a direct
    // path to that rectangle without requiring a named device preset.
    expect(chipSource).toMatch(/aria-label="Rotate the viewport"/)
    expect(chipSource).toMatch(/onclick=\{\(\) => pick\("custom"\)\}/)
  })

  test('declares the type rung once, in plain flow', () => {
    // WHY: `text-workspace-chrome` is the responsive rung — 12px on a laptop
    // display, 14px on a desktop one — and declaring it on the sheet is what
    // makes every row step together. Flow, never flex: as flex items the bands
    // compete for height and the preset list is the one that loses.
    expect(chipSource).toContain('<div class="text-workspace-chrome">')
    expect(chipSource).not.toContain('text-workspace-chrome flex flex-col')
  })

  test('leaves no fixed text size anywhere in the browser surfaces', () => {
    // WHY: a `text-xs` label beside a `text-workspace-chrome` one is 12px on
    // both displays, so it is correct on a laptop and a size too small on a
    // desktop. Every size here is either the rung or derived from it.
    const offenders: string[] = []
    for (const file of readdirSync(BROWSER_DIR)) {
      if (!file.endsWith('.svelte')) continue
      const source = readFileSync(join(BROWSER_DIR, file), 'utf8')
      for (const match of source.matchAll(/(?:^|["'\s])(text-(?:xs|sm|base|lg|xl|\[\d+px\]))(?![\w-])/g)) {
        offenders.push(`${file}: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
