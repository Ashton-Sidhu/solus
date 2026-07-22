<script lang="ts">
  let open = $state(false)

  function close(): void {
    open = false
  }

  function download(): void {
    window.parent.postMessage({ type: 'demo:cta-click' }, '*')
    if (window.self === window.top) window.open('https://solus.sh', '_blank', 'noopener,noreferrer')
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  $effect(() => {
    const show = () => { open = true }
    window.addEventListener('demo:show-cta', show)
    return () => window.removeEventListener('demo:show-cta', show)
  })
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="fixed inset-0 z-[10000] grid place-items-center bg-black/25 p-5 backdrop-blur-sm dark:bg-black/50"
    role="presentation"
    onclick={(event) => { if (event.currentTarget === event.target) close() }}
  >
    <div
      class="w-full max-w-[25rem] rounded-[1.25rem] border border-[var(--solus-popover-border)] bg-[color-mix(in_srgb,var(--solus-container-bg)_94%,transparent)] p-6 text-center shadow-[var(--solus-popover-shadow),0_1.5rem_5rem_rgba(0,0,0,0.16)] backdrop-blur-2xl dark:shadow-[var(--solus-popover-shadow),0_1.5rem_5rem_rgba(0,0,0,0.45)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-cta-title"
    >
      <div class="mb-5 flex items-center justify-center gap-2 text-[var(--solus-text-primary)]">
        <span class="grid size-7 place-items-center rounded-lg bg-[var(--solus-accent)] text-sm font-semibold text-white">S</span>
        <span class="text-base font-semibold tracking-[-0.025em]">Solus</span>
      </div>

      <h2 id="demo-cta-title" class="text-xl font-semibold tracking-[-0.025em] text-[var(--solus-text-primary)]">
        You’ve found the edge of the demo.
      </h2>
      <p class="mx-auto mt-2 max-w-[20rem] text-sm leading-6 text-[var(--solus-text-secondary)]">
        Agents need the real app to work with your code, tools, and repositories.
      </p>

      <div class="mt-6 grid gap-2">
        <button
          class="w-full cursor-pointer rounded-xl border-0 bg-[var(--solus-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-[filter,transform] hover:brightness-105 active:scale-[0.985] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--solus-accent)]"
          onclick={download}
        >
          Download Solus
        </button>
        <button
          class="w-full cursor-pointer rounded-xl border-0 bg-transparent px-4 py-2 text-sm font-medium text-[var(--solus-text-tertiary)] transition-colors hover:bg-[var(--solus-surface-hover)] hover:text-[var(--solus-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--solus-accent)]"
          onclick={close}
        >
          Keep exploring
        </button>
      </div>
    </div>
  </div>
{/if}
