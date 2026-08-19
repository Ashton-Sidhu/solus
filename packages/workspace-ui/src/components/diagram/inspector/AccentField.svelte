<script lang="ts">
  import * as Popover from '../../ui/popover'
  import { getSettingsContext } from '../../../contexts'
  import {
    DIAGRAM_GREEN,
    DIAGRAM_AMBER,
    DIAGRAM_RED,
    DIAGRAM_BLUE,
    DIAGRAM_PURPLE,
    DIAGRAM_GRAY,
    diagramAccent,
  } from '../diagram-colors'
  import ColorPickerPanel from './ColorPickerPanel.svelte'

  interface Props {
    /** `undefined` means "the default", whatever that means for this thing. */
    value: string | undefined
    /** What the first swatch is called: a node's Default, an edge's Neutral. */
    defaultLabel: string
    /** What the first swatch shows — the accent for a node, the stroke for an edge. */
    defaultSwatch: string
    /** Names the swatch group for screen readers, e.g. "Node accent". */
    groupLabel: string
    onSelect: (color: string | undefined) => void
  }

  let { value, defaultLabel, defaultSwatch, groupLabel, onSelect }: Props = $props()

  const theme = getSettingsContext()

  // The node and the edge palette are the same six colours; the only difference
  // is what "no colour" means, which arrives as a prop.
  const PRESETS: { value: string; label: string }[] = [
    { value: DIAGRAM_GREEN, label: 'Green' },
    { value: DIAGRAM_AMBER, label: 'Amber' },
    { value: DIAGRAM_RED, label: 'Red' },
    { value: DIAGRAM_BLUE, label: 'Blue' },
    { value: DIAGRAM_PURPLE, label: 'Purple' },
    { value: DIAGRAM_GRAY, label: 'Gray' },
  ]

  // A colour outside the presets came from the picker, so the custom swatch owns
  // the active ring and seeds the picker with it.
  const isCustom = $derived(value != null && !PRESETS.some((preset) => preset.value === value))
  const pickerValue = $derived(value ?? diagramAccent(theme.isDark))

  let pickerOpen = $state(false)
</script>

<div class="inspector-field">
  <span class="inspector-label">Accent</span>
  <div class="inspector-swatches" role="group" aria-label={groupLabel}>
    <button
      type="button"
      class="inspector-swatch"
      class:inspector-swatch--active={value === undefined}
      style="--swatch: {defaultSwatch}"
      aria-pressed={value === undefined}
      aria-label={defaultLabel}
      title={defaultLabel}
      onclick={() => onSelect(undefined)}
    ></button>
    {#each PRESETS as preset (preset.label)}
      <button
        type="button"
        class="inspector-swatch"
        class:inspector-swatch--active={value === preset.value}
        style="--swatch: {preset.value}"
        aria-pressed={value === preset.value}
        aria-label={preset.label}
        title={preset.label}
        onclick={() => onSelect(preset.value)}
      ></button>
    {/each}

    <!-- Shows the preset palette as a wheel until a custom colour is picked,
         then the colour itself. -->
    <Popover.Root bind:open={pickerOpen}>
      <Popover.Trigger
        class="inspector-swatch inspector-swatch--custom {isCustom
          ? 'inspector-swatch--active'
          : ''}"
        style="--swatch: {isCustom ? value : 'transparent'}"
        aria-label="Custom colour"
        title="Custom colour"
      />
      <Popover.Content
        class="w-[17.5rem] gap-0 rounded-[1.125rem] border-0 bg-(--solus-container-bg) p-3.5 shadow-[shadow:var(--solus-container-shadow)] ring-0"
        side="left"
        align="start"
        sideOffset={22}
        alignOffset={-8}
        collisionPadding={16}
      >
        <ColorPickerPanel
          value={pickerValue}
          onChange={(hex) => onSelect(hex)}
          onClose={() => (pickerOpen = false)}
        />
      </Popover.Content>
    </Popover.Root>
  </div>
</div>
