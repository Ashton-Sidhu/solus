<script lang="ts">
  import {
    completeHint,
    DEMO_HINTS,
    loadCompletedHints,
    pulseHintTarget,
    startHintPulse,
    type DemoHintId,
  } from './hints'

  let open = $state(false)
  let hidden = $state(false)
  let completed = $state<DemoHintId[]>(loadCompletedHints())
  let activePulse: Animation | undefined

  function startPreview(id: DemoHintId): void {
    activePulse?.cancel()
    activePulse = startHintPulse(id)
  }

  function stopPreview(): void {
    activePulse?.cancel()
    activePulse = undefined
  }

  function choose(id: DemoHintId): void {
    stopPreview()
    pulseHintTarget(id)
    completed = completeHint(completed, id)
  }

  function dismiss(): void {
    open = false
    hidden = true
  }
</script>

{#if !hidden}
  <div class="pointer-events-none fixed right-5 bottom-5 z-[9990] flex flex-col items-end text-[var(--solus-text-primary)] antialiased">
    {#if open}
      <div
        class="pointer-events-auto mb-2 w-[18rem] rounded-2xl bg-[color-mix(in_srgb,var(--solus-popover-bg)_96%,transparent)] p-2 shadow-[0_0_0_1px_var(--solus-popover-border),0_0.75rem_2.5rem_rgba(0,0,0,0.14)] backdrop-blur-2xl dark:shadow-[0_0_0_1px_var(--solus-popover-border),0_0.75rem_2.5rem_rgba(0,0,0,0.4)]"
        role="dialog"
        aria-labelledby="demo-hints-title"
      >
        <div class="px-2.5 pt-2 pb-1.5">
          <div id="demo-hints-title" class="text-[0.8125rem] font-semibold tracking-[-0.015em]">Things to try</div>
          <p class="mt-0.5 text-[0.6875rem] leading-4 text-[var(--solus-text-tertiary)]">Tour the workspace’s flagship surfaces.</p>
        </div>

        <div class="grid gap-0.5">
          {#each DEMO_HINTS as hint (hint.id)}
            {@const done = completed.includes(hint.id)}
            <button
              type="button"
              class="group flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 text-left text-[0.75rem] font-medium text-[var(--solus-text-secondary)] transition-[color,background-color,transform] duration-150 hover:bg-[var(--solus-surface-hover)] hover:text-[var(--solus-text-primary)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--solus-accent)]"
              aria-pressed={done}
              onmouseenter={() => startPreview(hint.id)}
              onmouseleave={stopPreview}
              onfocus={() => startPreview(hint.id)}
              onblur={stopPreview}
              onclick={() => choose(hint.id)}
            >
              <span
                class="grid size-5 shrink-0 place-items-center rounded-full text-[0.6875rem] transition-[color,background-color,transform] duration-200 {done ? 'bg-[var(--solus-accent)] text-white' : 'bg-[var(--solus-surface-hover)] text-[var(--solus-text-tertiary)] group-hover:scale-105'}"
                aria-hidden="true"
              >{done ? '✓' : '→'}</span>
              <span class={done ? 'text-[var(--solus-text-tertiary)] line-through' : ''}>{hint.label}</span>
            </button>
          {/each}
        </div>

        <button
          type="button"
          class="mt-1 min-h-10 w-full cursor-pointer rounded-xl border-0 bg-transparent px-3 text-[0.6875rem] font-semibold text-[var(--solus-text-tertiary)] transition-[color,background-color,transform] duration-150 hover:bg-[var(--solus-surface-hover)] hover:text-[var(--solus-text-primary)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--solus-accent)]"
          onclick={dismiss}
        >
          Got it
        </button>
      </div>
    {/if}

    <button
      type="button"
      class="pointer-events-auto min-h-10 cursor-pointer rounded-full border-0 bg-[var(--solus-popover-bg)] px-4 text-[0.75rem] font-semibold text-[var(--solus-text-primary)] shadow-[0_0_0_1px_var(--solus-popover-border),0_0.375rem_1.5rem_rgba(0,0,0,0.12)] transition-[background-color,box-shadow,transform] duration-150 hover:bg-[var(--solus-container-bg)] hover:shadow-[0_0_0_1px_var(--solus-popover-border),0_0.5rem_1.75rem_rgba(0,0,0,0.16)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--solus-accent)] dark:shadow-[0_0_0_1px_var(--solus-popover-border),0_0.375rem_1.5rem_rgba(0,0,0,0.42)]"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      ✨ Things to try
    </button>
  </div>
{/if}
