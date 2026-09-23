/**
 * The fonts installed on this client, for the Appearance font pickers.
 *
 * Read through the Local Font Access API (`queryLocalFonts`), which exists in
 * Chromium and Electron only. Electron's default permission handler approves
 * silently; a browser raises a permission prompt on the first call and needs
 * a user gesture for it, so `discoverInstalledFonts()` is called when a picker
 * opens. Where the API is absent (Safari, Firefox, mobile) or denied, the
 * pickers fall back to a typed family name.
 *
 * One store for every picker: once one learns the list, the rest have it.
 */

import { cssFontFamilies } from '../../../lib/font-family'

export type FontCatalogStatus =
  /** Not asked yet, or the permission is still pending. */
  | 'unknown'
  | 'granted'
  /** No API on this engine, or the permission was declined. */
  | 'unavailable'

type LocalFontsQuery = () => Promise<ReadonlyArray<{ readonly family: string }>>

/** The Local Font Access entry point, read once at the I/O boundary. Absent
 *  on engines without the API, which is the fallback signal. */
function localFontsQuery(): LocalFontsQuery | undefined {
  // SAFETY: `queryLocalFonts` is a Chromium-only global absent from the
  // TypeScript lib; it is read as an optional member and every caller treats
  // `undefined` as "no API".
  const host = globalThis as { queryLocalFonts?: LocalFontsQuery }
  return host.queryLocalFonts
}

class FontCatalog {
  status = $state<FontCatalogStatus>(localFontsQuery() === undefined ? 'unavailable' : 'unknown')
  /** Installed families, sorted, present only while `status` is `granted`. */
  families = $state<readonly string[]>([])

  private load: Promise<void> | null = null
  private grantedProbeStarted = false

  /** Query installed fonts. Call from a user gesture: the first call in a
   *  browser raises the local-fonts permission prompt. A denial is not
   *  remembered, so reopening the picker can ask again after the user changes
   *  the site setting. */
  discover(): void {
    if (this.status !== 'unknown' || this.load !== null) return
    const query = localFontsQuery()
    if (query === undefined) {
      this.status = 'unavailable'
      return
    }
    this.load = query
      .call(globalThis)
      .then((fonts) => {
        const families = [...new Set(fonts.map((font) => font.family))]
          // Dot-prefixed families are macOS-internal faces; picking one is
          // never intended and most refuse to render for web content anyway.
          .filter((family) => !family.startsWith('.'))
          .sort((left, right) => left.localeCompare(right))
        // A denied permission resolves with an empty list instead of throwing;
        // no machine has zero fonts, so empty means denied.
        if (families.length === 0) {
          this.status = 'unavailable'
          return
        }
        this.families = families
        this.status = 'granted'
      })
      .catch(() => {
        this.status = 'unavailable'
      })
      .finally(() => {
        this.load = null
      })
  }

  /** Discover without a gesture where the permission is already granted, so a
   *  picker renders the list on first open instead of after a second click.
   *  "prompt" and "denied" change nothing: raising the prompt still needs the
   *  gesture that `discover()` is called from. */
  probeGrantedPermission(): void {
    if (this.grantedProbeStarted || this.status !== 'unknown') return
    this.grantedProbeStarted = true
    const permissions = globalThis.navigator?.permissions
    if (permissions === undefined) return
    // SAFETY: 'local-fonts' is a Chromium permission name absent from the
    // TypeScript lib union; an engine that does not know it rejects the query,
    // which the rejection arm below treats as "keep the gesture flow".
    const localFonts = 'local-fonts' as PermissionName
    permissions.query({ name: localFonts }).then(
      (result) => {
        if (result.state === 'granted') this.discover()
      },
      () => {
        // The engine does not know the permission name; keep the gesture flow.
      },
    )
  }
}

export const fontCatalog = new FontCatalog()

const FONT_PROBE_TEXT = 'mmmmmmmmMMWli1O0@# fjord'
let probeContext: CanvasRenderingContext2D | null | undefined

function probeWidth(fontList: string): number | null {
  if (probeContext === undefined) probeContext = document.createElement('canvas').getContext('2d')
  if (probeContext === null) return null
  probeContext.font = `16px ${fontList}`
  return probeContext.measureText(FONT_PROBE_TEXT).width
}

/**
 * Whether a family is really installed. `document.fonts.check()` answers true
 * for a family that is not installed at all (nothing needs loading), so it
 * cannot tell. A family exists when swapping in at least one generic changes
 * the measured advance.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family)
  if (families === null) return false
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true
  try {
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      const baseline = probeWidth(generic)
      const candidate = probeWidth(`${families}, ${generic}`)
      if (baseline === null || candidate === null) return false
      if (candidate !== baseline) return true
    }
    return false
  } catch {
    return false
  }
}

const MONOSPACE_PROBE_VARIANTS = ['normal 400', 'normal 700', 'italic 400', 'italic 700'] as const
const MONOSPACE_PROBE_GLYPHS = ['i', 'M', 'W', '0', '@', '#', '.', ' '] as const
const MONOSPACE_ADVANCE_TOLERANCE = 0.01

/**
 * Whether a family draws every character on the same advance. The code and
 * diff surfaces need this: a proportional face sets narrower than the column
 * grid the cursor and gutter are laid on, which reads as ragged gaps.
 *
 * Unmeasurable environments answer true, so a missing canvas never blocks a
 * legitimate font.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family)
  if (families === null) return true
  try {
    if (probeContext === undefined) probeContext = document.createElement('canvas').getContext('2d')
    if (probeContext === null) return true
    const context = probeContext
    // A generic mono behind it, so an absent face measures as monospace and is
    // left for the normal fallback chain to resolve.
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width)
      const reference = advances[0]
      if (reference === undefined || reference <= 0) continue
      if (advances.some((advance) => Math.abs(advance - reference) >= MONOSPACE_ADVANCE_TOLERANCE)) return false
    }
    return true
  } catch {
    return true
  }
}
