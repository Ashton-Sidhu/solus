<script lang="ts">
  import { getWorkspaceContext } from "../contexts";
  import { tooltip } from "../lib/tooltip";
  import { requestInputFocus } from "../lib/inputFocus";
  import * as Popover from "./ui/popover";
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
    <Popover.Root bind:open onOpenChange={(next) => { if (!next) requestInputFocus() }}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            aria-haspopup="dialog"
            aria-label={`${pct}% of context window used`}
            data-testid="context-meter-trigger"
            class="group flex items-center rounded-full p-1 cursor-pointer transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
            use:tooltip={`${pct}% of context window used`}
          >
      <svg
        class="h-4 w-4 -rotate-90"
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
        {/snippet}
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start" sideOffset={6} class="z-[10002] w-[224px] gap-0 overflow-hidden rounded-xl border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
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
      </Popover.Content>
    </Popover.Root>
  </div>
{/if}
