<script lang="ts">
  import { getWorkspaceContext } from "../contexts/workspace.context.svelte";
  import { tooltip } from "../lib/tooltip";
  import { requestInputFocus } from "../lib/inputFocus";
  import Dropdown from "./ui/Dropdown.svelte";
  import {
    contextTokensUsed,
    resolveContextWindow,
    contextFraction,
  } from "../lib/contextUsage";

  let { tabId }: { tabId: string } = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));

  const usage = $derived(sess?.sessionUsage ?? null);
  const total = $derived(resolveContextWindow(sess));
  const used = $derived(contextTokensUsed(usage));
  const fraction = $derived(contextFraction(used, total));
  const pct = $derived(Math.round(fraction * 100));
  // Past 80% the context is getting tight — warn with the error hue.
  const warn = $derived(fraction >= 0.8);

  const result = $derived(sess?.lastResult ?? null);

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  function toggle() {
    open = !open;
    if (!open) requestInputFocus();
  }

  const rows = $derived(
    [
      { label: "Input", value: usage?.inputTokens ?? 0 },
      { label: "Cache read", value: usage?.cacheReadTokens ?? 0 },
      { label: "Cache write", value: usage?.cacheCreationTokens ?? 0 },
      { label: "Output", value: usage?.outputTokens ?? 0 },
      { label: "Reasoning output", value: usage?.reasoningTokens ?? 0 },
    ].filter((r) => r.value > 0),
  );
</script>

{#if tabId}
  <div class="flex items-center" data-testid="context-meter">
    <button
      bind:this={triggerEl}
      type="button"
      onclick={toggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${pct}% of context window used`}
      data-testid="context-meter-trigger"
      class="group flex items-center rounded-full p-1 cursor-pointer transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
      use:tooltip={`${pct}% of context window used`}
    >
      <svg
        class="h-3.5 w-3.5 -rotate-90"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="var(--solus-surface-active)"
          stroke-width="2"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke={warn ? "var(--solus-status-error)" : "var(--solus-accent)"}
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={2 * Math.PI * 6}
          stroke-dashoffset={2 * Math.PI * 6 * (1 - Math.max(fraction, 0.02))}
          class="transition-[stroke-dashoffset] duration-300 ease-out"
        />
      </svg>
    </button>

    <Dropdown bind:open {triggerEl} align="bottom" width={224}>
      <div
        role="dialog"
        aria-label="Context usage details"
        data-testid="context-meter-popover"
      >
        <div
          class="flex items-center justify-between px-3 py-1.5 border-b border-(--solus-permission-border)"
        >
          <span class="text-[0.6875rem] font-semibold text-(--solus-text-secondary)"
            >Context window</span
          >
          <span
            class="text-[0.6875rem] tabular-nums {warn
              ? 'text-(--solus-status-error)'
              : 'text-(--solus-accent)'}">{pct}%</span
          >
        </div>

        <div class="px-3 py-1.5 border-b border-(--solus-permission-border)">
          <div
            class="flex items-center justify-between text-[0.6875rem] text-(--solus-text-secondary) tabular-nums"
          >
            <span>{used.toLocaleString()}</span>
            <span class="text-(--solus-text-tertiary)"
              >of {total.toLocaleString()}</span
            >
          </div>
          <span
            class="mt-1 block h-[0.25rem] w-full rounded-full overflow-hidden bg-(--solus-surface-active)"
          >
            <span
              class="block h-full rounded-full"
              style="width:{Math.max(pct, 2)}%;background:{warn
                ? 'var(--solus-status-error)'
                : 'var(--solus-accent)'}"
            ></span>
          </span>
        </div>

        <div class="px-3 py-1.5 flex flex-col gap-1">
          {#each rows as row (row.label)}
            <div
              class="flex items-center justify-between text-[0.6875rem] tabular-nums"
            >
              <span class="text-(--solus-text-tertiary)">{row.label}</span>
              <span class="text-(--solus-text-secondary)"
                >{row.value.toLocaleString()}</span
              >
            </div>
          {/each}
          {#if result}
            <div class="my-0.5 h-px bg-(--solus-permission-border)"></div>
            {#if result.totalCostUsd > 0}
              <div
                class="flex items-center justify-between text-[0.6875rem] tabular-nums"
              >
                <span class="text-(--solus-text-tertiary)">Cost</span>
                <span class="text-(--solus-text-secondary)"
                  >${result.totalCostUsd.toFixed(4)}</span
                >
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </Dropdown>
  </div>
{/if}
