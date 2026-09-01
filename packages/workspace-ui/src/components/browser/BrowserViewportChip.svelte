<script lang="ts">
  import {
    Check,
    ChevronDown,
    Monitor,
    RotateCcw,
    Smartphone,
    Tablet,
  } from "@lucide/svelte";
  import {
    DEVICE_PRESETS,
    BROWSER_MAX_DIMENSION,
    BROWSER_MIN_DIMENSION,
    type BrowserViewport,
    type BrowserViewportRequest,
  } from "@solus/contracts/browser-types";
  import * as Popover from "../ui/popover";

  /**
   * Size is the pane's most-changed setting, so it is a labelled chip rather
   * than an icon: the two numbers, how much the stage had to shrink them, and a
   * caret into the picker.
   *
   * The picker answers every way a person asks for a size. The pane itself and
   * named devices, because a preset covers what we specify against. The exact
   * rectangle with rotate, because a breakpoint is a number and typing it has to
   * be as cheap as picking a phone.
   */

  interface Props {
    viewport: BrowserViewport;
    /**
     * How much the stage had to shrink the device to fit, 0–1. Stated beside the
     * numbers because a picture at 62% is a picture the user must not measure
     * anything against by eye. Zero means the stage has not measured yet.
     */
    scale: number;
    onViewport: (request: BrowserViewportRequest) => void;
  }

  let {
    viewport,
    scale,
    onViewport,
  }: Props = $props();

  let open = $state(false);

  const GROUP_LABELS = { phone: "Phone", tablet: "Tablet", desktop: "Desktop" };
  const GROUPS = ["phone", "tablet", "desktop"] as const;

  const selected = $derived(
    viewport.mode === "preset" ? (viewport.presetId ?? "custom") : viewport.mode,
  );

  /** How much the stage had to shrink the device. A picture at 62% is a picture
   *  nothing may be measured against by eye; at 1:1 there is nothing to warn
   *  about. */
  const scaleLabel = $derived(
    scale > 0 && scale !== 1 ? `${Math.round(scale * 100)}%` : "",
  );

  /** The glyph reads the width rather than the mode, so a typed 390 and the
   *  iPhone preset it matches are the same shape on the chip. Two numbers state
   *  the size; the glyph is what makes the chip legible at a glance. */
  const ChipIcon = $derived(
    viewport.width < 600 ? Smartphone : viewport.width < 1024 ? Tablet : Monitor,
  );

  // Only held while a field has focus. Everywhere else the server's numbers are
  // the truth, including the ones a fill drag or an agent just changed.
  let draft = $state<{ width: string; height: string } | null>(null);
  const shown = $derived(
    draft ?? { width: String(viewport.width), height: String(viewport.height) },
  );

  function pick(value: string) {
    if (value === "fill") {
      onViewport({ mode: "fill", width: viewport.width, height: viewport.height });
      return;
    }
    // "Custom" keeps the size and releases it: the numbers stop being a device's
    // and become the user's, which is what makes them editable from a preset.
    if (value === "custom") {
      onViewport({ mode: "custom", width: viewport.width, height: viewport.height });
      return;
    }
    onViewport({ mode: "preset", presetId: value, orientation: "portrait" });
  }

  function commitDraft() {
    const pending = draft;
    draft = null;
    if (!pending) return;
    const width = Number(pending.width);
    const height = Number(pending.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width === viewport.width && height === viewport.height) return;
    onViewport({ mode: "custom", width, height, hasTouch: viewport.hasTouch });
  }

  function edit(axis: "width" | "height", value: string) {
    draft = { ...shown, [axis]: value };
  }

  /** Rotating a device swaps its orientation; rotating a rectangle swaps the
   *  numbers. Both read as the same gesture to the user. */
  function rotate() {
    if (viewport.mode === "preset" && viewport.presetId) {
      onViewport({
        mode: "preset",
        presetId: viewport.presetId,
        orientation:
          viewport.orientation === "portrait" ? "landscape" : "portrait",
      });
      return;
    }
    onViewport({
      mode: "custom",
      width: viewport.height,
      height: viewport.width,
      hasTouch: viewport.hasTouch,
    });
  }

</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="text-workspace-chrome flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 tabular-nums shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-colors {open
      ? 'bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest)]'
      : 'hover:bg-[var(--wash-2)]'}"
    aria-label="Viewport size"
  >
    <ChipIcon
      class="size-3 shrink-0 text-(--solus-text-tertiary)"
      aria-hidden="true"
    />
    <span class="text-(--solus-text-primary)">
      {viewport.width} × {viewport.height}
    </span>
    {#if scaleLabel}
      <span class="text-(--solus-text-tertiary)">{scaleLabel}</span>
    {/if}
    <ChevronDown class="size-2.5 text-(--solus-text-tertiary)" />
  </Popover.Trigger>

  <Popover.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="max-h-[calc(100vh-8rem)] w-[min(18.5rem,calc(100vw-2rem))] overflow-y-auto p-1.5"
    aria-label="Viewport size"
  >
    <!-- The rung is declared once here and inherited by the whole sheet, so the
         picker steps between its laptop and desktop sizes as one surface. Plain
         flow, never flex: as flex items the bands compete for height and the
         preset list is the one that loses. -->
    <div class="text-workspace-chrome">
      <div
        class="px-2 pt-1 pb-1.5 font-medium tracking-widest text-(--solus-text-tertiary) uppercase"
      >
        Presets
      </div>

      <button
        type="button"
        class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-[var(--wash-2)]"
        aria-pressed={selected === "fill"}
        onclick={() => pick("fill")}
      >
        <Monitor class="size-3.5 shrink-0 text-(--solus-text-tertiary)" />
        <span class="flex-1 text-(--solus-text-primary)">
          Fill pane
        </span>
        {#if selected === "fill"}
          <Check class="size-3 shrink-0 text-[var(--primary)]" />
        {/if}
      </button>

      <div role="group" aria-label="Device presets">
        {#each GROUPS as group (group)}
          <div
            class="px-2 pt-2 pb-1 text-(--solus-text-tertiary)"
          >
            {GROUP_LABELS[group]}
          </div>
          {#each DEVICE_PRESETS.filter((preset) => preset.group === group) as preset (preset.id)}
            <button
              type="button"
              class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-[var(--wash-2)]"
              aria-pressed={selected === preset.id}
              onclick={() => pick(preset.id)}
            >
              <span class="shrink-0 text-(--solus-text-tertiary)">
                {#if group === "phone"}<Smartphone class="size-3.5" />
                {:else if group === "tablet"}<Tablet class="size-3.5" />
                {:else}<Monitor class="size-3.5" />{/if}
              </span>
              <span
                class="min-w-0 flex-1 truncate text-(--solus-text-primary)"
              >
                {preset.label}
              </span>
              <span
                class="shrink-0 tabular-nums text-(--solus-text-tertiary)"
              >
                {preset.width} × {preset.height}
              </span>
              {#if selected === preset.id}
                <Check class="size-3 shrink-0 text-[var(--primary)]" />
              {/if}
            </button>
          {/each}
        {/each}
      </div>

      <div class="my-1.5 h-px bg-[var(--hairline)]"></div>

      <!-- The exact rectangle. Typing here is what releases a preset: the numbers
           stop being a device's and become the user's. -->
      <div class="flex items-center gap-1.5 px-1 pb-1">
        <div
          class="flex h-7 items-center gap-1 rounded-lg bg-[var(--wash-1)] px-2 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]"
        >
          <input
            class="text-workspace-chrome w-14 bg-transparent text-center tabular-nums text-(--solus-text-primary) outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            type="number"
            inputmode="numeric"
            min={BROWSER_MIN_DIMENSION}
            max={BROWSER_MAX_DIMENSION}
            value={shown.width}
            aria-label="Viewport width"
            oninput={(event) => edit("width", event.currentTarget.value)}
            onblur={commitDraft}
            onkeydown={(event) => {
              if (event.key === "Enter") commitDraft();
              if (event.key === "Escape") draft = null;
            }}
          />
          <span class="text-(--solus-text-tertiary)">×</span>
          <input
            class="text-workspace-chrome w-14 bg-transparent text-center tabular-nums text-(--solus-text-primary) outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            type="number"
            inputmode="numeric"
            min={BROWSER_MIN_DIMENSION}
            max={BROWSER_MAX_DIMENSION}
            value={shown.height}
            aria-label="Viewport height"
            oninput={(event) => edit("height", event.currentTarget.value)}
            onblur={commitDraft}
            onkeydown={(event) => {
              if (event.key === "Enter") commitDraft();
              if (event.key === "Escape") draft = null;
            }}
          />
        </div>
        <button
          type="button"
          class="flex size-7 shrink-0 items-center justify-center rounded-lg text-(--solus-text-secondary) shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
          aria-label="Rotate the viewport"
          title="Rotate the viewport"
          onclick={rotate}
        >
          <RotateCcw class="size-3.5" />
        </button>
        <span class="flex-1"></span>
        <button
          type="button"
          class="shrink-0 rounded-md px-2 py-1 text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
          aria-pressed={selected === "custom"}
          onclick={() => pick("custom")}
        >
          Custom
        </button>
      </div>
    </div>
  </Popover.Content>
</Popover.Root>
