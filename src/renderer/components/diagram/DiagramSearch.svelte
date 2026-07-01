<script lang="ts">
  import { Panel, useSvelteFlow } from '@xyflow/svelte'

  interface Props {
    onMatchedChange: (ids: Set<string> | null) => void
    onClose: () => void
  }

  let { onMatchedChange, onClose }: Props = $props()

  const flow = useSvelteFlow()

  let query = $state('')
  let inputEl: HTMLInputElement | undefined
  let count = $state<number | null>(null)

  $effect(() => {
    inputEl?.focus()
  })

  function runSearch() {
    const q = query.trim().toLowerCase()
    if (!q) {
      count = null
      onMatchedChange(null)
      return
    }
    const matched = flow.getNodes().filter((n) =>
      String(n.data?.label ?? '').toLowerCase().includes(q),
    )
    count = matched.length
    onMatchedChange(new Set(matched.map((n) => n.id)))

    const first = matched[0]
    if (first) {
      const w = (first.measured?.width ?? first.width ?? 200) as number
      const h = (first.measured?.height ?? first.height ?? 80) as number
      void flow.setCenter(first.position.x + w / 2, first.position.y + h / 2, {
        zoom: 1.2,
        duration: 300,
      })
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape') onClose()
  }
</script>

<Panel position="top-left">
  <div class="flex items-center gap-[0.4375rem] rounded-[0.625rem] border border-(--solus-container-border) bg-(--solus-container-bg) px-2 py-[0.3125rem] text-(--solus-text-tertiary) shadow-(--solus-container-shadow)">
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
    <input
      bind:this={inputEl}
      bind:value={query}
      oninput={runSearch}
      onkeydown={handleKeydown}
      class="w-36 border-0 bg-transparent text-[0.75rem] font-medium text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)"
      placeholder="Search nodes…"
      aria-label="Search nodes"
    />
    {#if count !== null}
      <span class="text-[0.625rem] font-semibold text-(--solus-text-tertiary) tabular-nums">{count}</span>
    {/if}
    <button type="button" class="grid size-[1.125rem] cursor-pointer place-items-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) transition-[background,color] duration-120 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)" onclick={onClose} title="Close (Esc)" aria-label="Close search">
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </div>
</Panel>
