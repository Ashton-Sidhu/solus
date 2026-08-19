<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    variant?: 'inline' | 'standalone' | 'hint' | 'accent' | 'keycap'
    size?: 'sm' | 'md'
    class?: string
    children: Snippet
  }

  let {
    variant = 'inline',
    size = 'sm',
    class: extraClass = '',
    children,
  }: Props = $props()

  const sizeClass = $derived(
    size === 'md' ? 'text-workspace-chrome' : 'text-chrome-shelf',
  )

  const variantClass = $derived.by(() => {
    if (variant === 'standalone') {
      return 'rounded bg-(--solus-surface-primary) border border-(--solus-tool-border) px-1.5 py-0.5 pointer-fine:[.is-laptop-display_&]:px-1 pointer-fine:[.is-laptop-display_&]:py-0.25 text-(--solus-text-tertiary)'
    }
    if (variant === 'hint') {
      return 'h-4 min-w-4 rounded bg-(--solus-surface-hover) px-1 pointer-fine:[.is-laptop-display_&]:h-3.5 pointer-fine:[.is-laptop-display_&]:min-w-3.5 pointer-fine:[.is-laptop-display_&]:px-0.75 text-(--solus-text-tertiary)'
    }
    // A physical key: hairline ring plus a bottom bevel, so it reads as raised
    // rather than as a flat tinted chip.
    if (variant === 'keycap') {
      return 'h-[1.0625rem] min-w-[1.0625rem] rounded-md bg-(--solus-surface-hover) px-1.5 pointer-fine:[.is-laptop-display_&]:h-[0.9375rem] pointer-fine:[.is-laptop-display_&]:min-w-[0.9375rem] pointer-fine:[.is-laptop-display_&]:px-1 text-(--solus-text-tertiary) shadow-[shadow:0_0_0_0.03125rem_var(--solus-popover-border),inset_0_-0.0625rem_0_var(--solus-menu-hairline)]'
    }
    if (variant === 'accent') {
      return 'h-[0.9375rem] min-w-3.5 rounded-[0.1875rem] bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)] px-[0.1875rem] pointer-fine:[.is-laptop-display_&]:h-3.5 pointer-fine:[.is-laptop-display_&]:min-w-3 pointer-fine:[.is-laptop-display_&]:px-0.5 text-(--solus-accent)'
    }
    return 'opacity-45'
  })

  const shiftClass = $derived(
    extraClass.split(/\s+/).includes('kbd-shift') ? 'font-medium' : '',
  )
</script>

<kbd class="inline-flex shrink-0 items-center justify-center leading-none tabular-nums {sizeClass} {variantClass} {shiftClass} {extraClass}">
  {@render children()}
</kbd>
