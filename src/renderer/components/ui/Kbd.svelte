<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    variant?: 'inline' | 'standalone' | 'hint' | 'accent'
    size?: 'sm' | 'md'
    class?: string
    children: Snippet
  }

  let {
    variant = 'inline',
    class: extraClass = '',
    children,
  }: Props = $props()

  const variantClass = $derived.by(() => {
    if (variant === 'standalone') {
      return 'rounded bg-(--solus-surface-primary) border border-(--solus-tool-border) px-1.5 py-0.5 text-[0.625rem] text-(--solus-text-tertiary)'
    }
    if (variant === 'hint') {
      return 'h-4 min-w-4 rounded bg-(--solus-surface-hover) px-1 text-[0.625rem] text-(--solus-text-tertiary)'
    }
    if (variant === 'accent') {
      return 'h-[0.9375rem] min-w-3.5 rounded-[0.1875rem] bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)] px-[0.1875rem] text-[0.625rem] text-(--solus-accent)'
    }
    return 'text-[0.625rem] opacity-45'
  })

  const shiftClass = $derived(
    extraClass.split(/\s+/).includes('kbd-shift') ? 'text-[0.6875rem] font-[650]' : '',
  )
</script>

<kbd class="inline-flex items-center justify-center font-mono leading-none tracking-[0.02em] tabular-nums {variantClass} {shiftClass} {extraClass}">
  {@render children()}
</kbd>
