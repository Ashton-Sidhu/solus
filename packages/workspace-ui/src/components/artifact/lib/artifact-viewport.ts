import { DEVICE_PRESETS } from '@solus/contracts/browser-types'

/**
 * The widths an artifact pane can hold its render to.
 *
 * Same catalogue the browser pane offers, reduced to what matters here: an
 * artifact has no viewport of its own, only a width, so two devices that are
 * 390 CSS pixels wide are one choice. `fit` is the pane's own width and is the
 * resting state — the frame is chrome-less by default and a fixed width is a
 * deliberate check, not a mode to live in.
 */
export interface ArtifactWidthOption {
  value: string
  label: string
  /** CSS pixels, or null for the pane's own width. */
  width: number | null
}

export const ARTIFACT_WIDTH_OPTIONS: readonly ArtifactWidthOption[] = [
  { value: 'fit', label: 'Fit', width: null },
  ...dedupeByWidth(),
]

function dedupeByWidth(): ArtifactWidthOption[] {
  const seen = new Set<number>()
  const options: ArtifactWidthOption[] = []
  for (const preset of DEVICE_PRESETS) {
    if (seen.has(preset.width)) continue
    seen.add(preset.width)
    options.push({ value: String(preset.width), label: `${preset.label} · ${preset.width}`, width: preset.width })
  }
  return options.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
}

export function artifactWidthFor(value: string): number | null {
  return ARTIFACT_WIDTH_OPTIONS.find((option) => option.value === value)?.width ?? null
}
