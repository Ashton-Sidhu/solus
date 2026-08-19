<script lang="ts">
  import { clamp01, hexToHsv, hsvToHex, normalizeHex, type Hsv } from '../lib/color'

  interface Props {
    /** The colour being edited, always a resolved `#rrggbb`. */
    value: string
    /** Fires on every drag frame — the canvas updates live, there is no Apply. */
    onChange: (hex: string) => void
    onClose: () => void
  }

  let { value, onChange, onClose }: Props = $props()

  // The picker edits in HSV and owns that state while it is open: hue survives a
  // drag into pure black, which a round-trip through the hex string would lose.
  /** The hex field shows the body only — the `#` is chrome, as in the mock. */
  function hexBody(hex: string): string {
    return hex.replace(/^#/, '').toUpperCase()
  }

  let hsv = $state<Hsv>({ h: 0, s: 0, v: 1 })
  // Held exactly as typed so a half-finished hex is never rewritten under the
  // caret; only a complete one moves the colour.
  let hexDraft = $state('')
  // Empty until the sync below runs, which is why that runs on mount too.
  let syncedHex = $state('')

  $effect(() => {
    // Seeds the controls, then resyncs only when the colour changed somewhere
    // else — a preset swatch clicked while the picker is open. Our own edits
    // already match, so a drag never fights this.
    if (value !== syncedHex) {
      syncedHex = value
      hexDraft = hexBody(value)
      const next = hexToHsv(value)
      if (next) hsv = next
    }
  })

  const hueColor = $derived(hsvToHex({ h: hsv.h, s: 1, v: 1 }))
  const lightnessPercent = $derived(Math.round((1 - hsv.v) * 100))

  function emit(next: Hsv) {
    hsv = next
    const hex = hsvToHex(next)
    hexDraft = hexBody(hex)
    syncedHex = hex
    onChange(hex)
  }

  let squareEl = $state<HTMLDivElement | undefined>()
  let dragging = $state(false)

  function pickFromPointer(e: PointerEvent) {
    if (!squareEl) return
    const rect = squareEl.getBoundingClientRect()
    emit({
      h: hsv.h,
      s: clamp01((e.clientX - rect.left) / rect.width),
      v: 1 - clamp01((e.clientY - rect.top) / rect.height),
    })
  }

  function startDrag(e: PointerEvent) {
    e.preventDefault()
    squareEl?.setPointerCapture(e.pointerId)
    dragging = true
    pickFromPointer(e)
  }

  function endDrag(e: PointerEvent) {
    if (!dragging) return
    dragging = false
    squareEl?.releasePointerCapture(e.pointerId)
  }

  // Keyboard parity for the square: the two rails are real range inputs and get
  // arrow keys for free, so this is the only control that has to spell it out.
  function nudgeSquare(e: KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.02
    const delta =
      e.key === 'ArrowLeft'
        ? { s: -step, v: 0 }
        : e.key === 'ArrowRight'
          ? { s: step, v: 0 }
          : e.key === 'ArrowUp'
            ? { s: 0, v: step }
            : e.key === 'ArrowDown'
              ? { s: 0, v: -step }
              : null
    if (!delta) return
    e.preventDefault()
    emit({ h: hsv.h, s: clamp01(hsv.s + delta.s), v: clamp01(hsv.v + delta.v) })
  }

  function editHex(raw: string) {
    hexDraft = raw
    const normal = normalizeHex(raw)
    if (!normal) return
    const next = hexToHsv(normal)
    if (!next) return
    // Keep the drafted text as typed; only the colour state follows.
    hsv = next
    syncedHex = normal
    onChange(normal)
  }
</script>

<div class="picker">
  <div class="picker__head">
    <span class="picker__title">Change color</span>
    <button type="button" class="picker__close" onclick={onClose} aria-label="Close colour picker">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  </div>

  <!-- Saturation across, brightness down: the square is the picker's main
       surface, so it gets the height and the two rails stay thin. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <div
    class="picker__square"
    bind:this={squareEl}
    style="--hue:{hueColor}; --picked:{value}"
    role="slider"
    tabindex="0"
    aria-label="Saturation and brightness"
    aria-valuetext="{Math.round(hsv.s * 100)}% saturation, {Math.round(hsv.v * 100)}% brightness"
    aria-valuenow={Math.round(hsv.v * 100)}
    aria-valuemin="0"
    aria-valuemax="100"
    onpointerdown={startDrag}
    onpointermove={(e) => dragging && pickFromPointer(e)}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onkeydown={nudgeSquare}
  >
    <span
      class="picker__knob"
      style="left:{hsv.s * 100}%; top:{(1 - hsv.v) * 100}%"
      aria-hidden="true"
    ></span>
  </div>

  <input
    type="range"
    class="picker__rail picker__rail--hue"
    min="0"
    max="360"
    step="1"
    value={hsv.h}
    style="--picked:{hueColor}"
    oninput={(e) => emit({ ...hsv, h: Number(e.currentTarget.value) })}
    aria-label="Hue"
  />

  <label class="picker__hex">
    <span class="picker__hash" aria-hidden="true">#</span>
    <input
      class="picker__hex-input"
      value={hexDraft}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      maxlength="7"
      oninput={(e) => editHex(e.currentTarget.value)}
      onblur={() => (hexDraft = hexBody(value))}
      aria-label="Hex colour"
    />
  </label>

  <!-- The same brightness axis as the square's vertical, given its own coarse
       rail because "a shade lighter" is the edit people reach for most. -->
  <div class="picker__row">
    <span class="picker__row-label">Lightness</span>
    <div class="picker__lightness">
      <span class="picker__pole" aria-hidden="true">L</span>
      <input
        type="range"
        class="picker__rail picker__rail--lightness"
        min="0"
        max="100"
        step="1"
        value={lightnessPercent}
        style="--fill:{lightnessPercent}%"
        oninput={(e) => emit({ ...hsv, v: 1 - Number(e.currentTarget.value) / 100 })}
        aria-label="Lightness"
      />
      <span class="picker__pole" aria-hidden="true">D</span>
    </div>
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .picker__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .picker__title {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--solus-text-primary);
  }

  .picker__close {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    border-radius: 9999px;
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .picker__close:hover {
    background: var(--solus-surface-active);
    color: var(--solus-text-primary);
  }

  .picker__close:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* White → hue across, transparent → black down. Two layers, so the corner
     colours stay exact rather than being blended twice. */
  .picker__square {
    position: relative;
    height: 9.5rem;
    border-radius: 0.75rem;
    background:
      linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, var(--hue));
    box-shadow: inset 0 0 0 0.0625rem rgba(0, 0, 0, 0.14);
    cursor: crosshair;
    touch-action: none;
  }

  .picker__square:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.1875rem;
  }

  .picker__knob {
    position: absolute;
    width: 1.375rem;
    height: 1.375rem;
    margin: -0.6875rem 0 0 -0.6875rem;
    border-radius: 9999px;
    background: var(--picked);
    box-shadow:
      inset 0 0 0 0.25rem #fff,
      0 0.125rem 0.5rem rgba(0, 0, 0, 0.35);
    pointer-events: none;
  }

  /* Both rails share the thumb, and differ only in what fills the track. */
  .picker__rail {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    height: 1.375rem;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  .picker__rail::-webkit-slider-runnable-track {
    height: 1.375rem;
    border-radius: 9999px;
    background: var(--track);
    box-shadow: inset 0 0 0 0.0625rem rgba(0, 0, 0, 0.14);
  }

  .picker__rail::-moz-range-track {
    height: 1.375rem;
    border-radius: 9999px;
    background: var(--track);
    box-shadow: inset 0 0 0 0.0625rem rgba(0, 0, 0, 0.14);
  }

  .picker__rail::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 1.375rem;
    height: 1.375rem;
    border: none;
    border-radius: 9999px;
    background: var(--picked, #fff);
    box-shadow:
      inset 0 0 0 0.25rem #fff,
      0 0.125rem 0.375rem rgba(0, 0, 0, 0.35);
  }

  .picker__rail::-moz-range-thumb {
    width: 1.375rem;
    height: 1.375rem;
    border: none;
    border-radius: 9999px;
    background: var(--picked, #fff);
    box-shadow:
      inset 0 0 0 0.25rem #fff,
      0 0.125rem 0.375rem rgba(0, 0, 0, 0.35);
  }

  .picker__rail:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.1875rem;
    border-radius: 9999px;
  }

  .picker__rail--hue {
    --track: linear-gradient(
      to right,
      #ff0000,
      #ffff00,
      #00ff00,
      #00ffff,
      #0000ff,
      #ff00ff,
      #ff0000
    );
  }

  /* Filled to the knob, empty after it — the shape of the reference control. */
  .picker__rail--lightness {
    --track: linear-gradient(
      to right,
      var(--solus-accent) 0 var(--fill),
      var(--solus-surface-active) var(--fill) 100%
    );
    --picked: var(--solus-accent);
  }

  .picker__hex {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    padding: 0.5rem 0.75rem;
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 0.625rem;
    background: var(--solus-surface-hover);
    transition: border-color var(--duration-quick) var(--ease-premium);
  }

  .picker__hex:focus-within {
    border-color: var(--solus-accent-border-medium);
  }

  .picker__hash {
    flex: none;
    font-family: var(--solus-code-font-family);
    font-size: var(--text-sm);
    color: var(--solus-text-tertiary);
  }

  .picker__hex-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    font-family: var(--solus-code-font-family);
    font-size: var(--text-sm);
    letter-spacing: 0.04em;
    color: var(--solus-text-primary);
  }

  .picker__row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .picker__row-label {
    flex: none;
    font-size: var(--text-sm);
    color: var(--solus-text-secondary);
  }

  .picker__lightness {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.1875rem 0.625rem;
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 9999px;
  }

  .picker__pole {
    flex: none;
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
  }

  @media (prefers-reduced-motion: reduce) {
    .picker__close,
    .picker__hex {
      transition: none;
    }
  }
</style>
