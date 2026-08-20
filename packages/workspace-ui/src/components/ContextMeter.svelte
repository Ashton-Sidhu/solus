<script lang="ts">
  import { getWorkspaceContext } from "../contexts";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { Gauge as GaugeIcon } from "@lucide/svelte";
  import { requestInputFocus } from "../lib/inputFocus";
  import * as Popover from "./ui/popover";
  import {
    contextTokensUsed,
    contextLimit,
    contextUsedFraction,
    formatTokens,
  } from "../lib/contextUsage";

  let { tabId }: { tabId: string } = $props();

  const workspace = getWorkspaceContext();
  const session = $derived(workspace.sessionFor(tabId));

  const context = $derived(session?.contextUsage ?? null);
  const limit = $derived(contextLimit(session));
  const used = $derived(contextTokensUsed(session));
  const usedFraction = $derived(contextUsedFraction(used, limit));
  const usedPct = $derived(Math.round(usedFraction * 100));
  const remaining = $derived(Math.max(0, limit - used));
  // Past 80% the session is close to compacting — warn.
  const warn = $derived(usedFraction >= 0.8);
  // Always a figure, never a placeholder: a tab that hasn't run a turn reads 0%
  // and fills in from there. The popover carries the caveat that nothing has
  // been reported yet.
  const label = $derived(`${usedPct}%`);
  // Only a compaction threshold is worth naming; a raw window is just the limit.
  const compactAt = $derived(context?.compactAtTokens ?? null);

  const fillColor = $derived(
    warn
      ? "var(--solus-status-error)"
      : "color-mix(in oklch, var(--solus-text-primary) 30%, transparent)",
  );

  const result = $derived(session?.lastResult ?? null);
  const runUsage = $derived(session?.runUsage ?? null);

  let open = $state(false);

  const windowRows = $derived(
    [
      { label: "Input", value: context?.inputTokens ?? 0 },
      { label: "Cache read", value: context?.cacheReadTokens ?? 0 },
      { label: "Cache write", value: context?.cacheCreationTokens ?? 0 },
      { label: "Output", value: context?.outputTokens ?? 0 },
    ].filter((row) => row.value > 0),
  );

  const runRows = $derived(
    [
      { label: "Output", value: runUsage?.outputTokens ?? 0 },
      { label: "Reasoning output", value: runUsage?.reasoningTokens ?? 0 },
    ].filter((row) => row.value > 0),
  );
</script>

<!-- Status, not action: a rule that stays monochrome until the window is
     genuinely tight, then goes red. The inline meter and the popover's own read
     the same way — one shape, two sizes — so the panel confirms the chip rather
     than restating it in another form. -->
{#snippet meter(sizing: string)}
  <span
    class="block overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--solus-text-primary)_12%,transparent)] {sizing}"
  >
    {#if context}
      <span
        class="block h-full rounded-full transition-[width] duration-300 ease-out"
        style="width:{Math.max(usedPct, 2)}%;background:{fillColor}"
      ></span>
    {/if}
  </span>
{/snippet}

{#snippet statRow(rowLabel: string, value: string)}
  <div class="flex min-h-5 items-center justify-between gap-3">
    <span class="min-w-0 truncate text-(--solus-text-tertiary)">{rowLabel}</span>
    <span class="shrink-0 font-secondary text-(--solus-text-primary) tabular-nums"
      >{value}</span
    >
  </div>
{/snippet}

{#if tabId}
  <div class="flex items-center" data-testid="context-meter">
    <Popover.Root bind:open onOpenChange={(next) => { if (!next) requestInputFocus() }}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            {...props}
            type="button"
            aria-haspopup="dialog"
            aria-label={context
              ? `${usedPct}% of context used`
              : "Context usage not reported yet"}
            data-testid="context-meter-trigger"
            class="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-(--solus-text-tertiary) transition-[background-color,scale] hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
          >
      {@render meter("h-[0.1875rem] w-[2.625rem] shrink-0")}
      <span
        class="tabular-nums {context ? ' opacity-65' : 'opacity-55'}"
        data-testid="context-meter-label">{label}</span
      >
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content
              value={!context
                ? "Context usage is reported after the first response"
                : compactAt
                  ? `${usedPct}% of context used — auto-compacts at ${formatTokens(compactAt)}`
                  : `${usedPct}% of context used`}
            />
          </TooltipUI.Root>
        {/snippet}
      </Popover.Trigger>
      <!-- Same surface as the orb's progress and changed-files popovers: the
           popover tokens, a 1rem radius and a hairline border, an icon tile
           leading the head. The `shadow:` type hint is what evicts
           Popover.Content's stock `shadow-md` — without it tailwind-merge reads
           the arbitrary value as a shadow *colour* and both survive.
           `lg:text-xs` restates the size for the primitive's
           `lg:text-sm`, which is its own merge group. -->
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        role="dialog"
        aria-label="Context usage details"
        data-testid="context-meter-popover"
        class="z-[10002] w-[17rem] gap-0 overflow-hidden rounded-2xl border-[0.0313rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 text-xs lg:text-xs text-(--solus-text-secondary) shadow-[shadow:var(--solus-popover-shadow)] ring-0"
      >
        <Popover.Header
          class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-[color-mix(in_srgb,var(--solus-container-border)_32%,transparent)] px-4 py-3.5 text-xs lg:text-xs"
        >
          <span
            class="inline-flex size-8 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--solus-text-tertiary)_8%,transparent)] text-(--solus-text-secondary)"
            aria-hidden="true"
          >
            <GaugeIcon size={16} weight="regular" />
          </span>
          <div class="flex min-w-0 items-baseline gap-2">
            <Popover.Title
              class="truncate text-sm leading-[1.25] font-medium text-(--solus-text-primary)"
              >Context window</Popover.Title
            >
            <span
              class="shrink-0 leading-[1.25] font-medium text-(--solus-text-tertiary) tabular-nums"
              >{formatTokens(limit)}</span
            >
          </div>
          <span
            class="shrink-0 font-secondary tabular-nums {warn
              ? 'text-(--solus-status-error)'
              : 'text-(--solus-text-primary)'}">{usedPct}%</span
          >
        </Popover.Header>

        <!-- Both states share this shape — a headline pair, the bar, then one
             footnote line — so opening the popover before the first turn shows
             the same meter, just unfilled, instead of a stray paragraph. -->
        <div
          class="border-b border-[color-mix(in_srgb,var(--solus-container-border)_32%,transparent)] px-4 py-3"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span
              class="font-secondary tabular-nums {context
                ? 'text-(--solus-text-primary)'
                : 'text-(--solus-text-tertiary)'}"
              >{context ? `${formatTokens(used)} used` : "Not measured yet"}</span
            >
            <span class="text-(--solus-text-tertiary) tabular-nums"
              >{context ? `${formatTokens(remaining)} left` : "no report yet"}</span
            >
          </div>
          {@render meter("mt-2 h-[0.25rem] w-full")}
          <Popover.Description
            class="mt-2 block text-xs leading-[1.35] text-(--solus-text-tertiary) tabular-nums"
          >
            {#if !context}
              Fills in after the first response
            {:else if compactAt}
              Auto-compacts at {formatTokens(compactAt)}
            {:else}
              {formatTokens(limit)} window
            {/if}
          </Popover.Description>
        </div>

        {#if windowRows.length > 0}
          <div class="flex flex-col gap-1 px-4 py-2.5">
            {#each windowRows as row (row.label)}
              {@render statRow(row.label, row.value.toLocaleString())}
            {/each}
          </div>
        {/if}

        <!-- Spend for the last run. Deliberately below its own heading: these
             tokens are billed but never occupy the window above. -->
        {#if runRows.length > 0 || (result && result.totalCostUsd > 0)}
          <div
            class="flex flex-col gap-1 border-t border-[color-mix(in_srgb,var(--solus-container-border)_32%,transparent)] px-4 py-2.5"
          >
            <span class="font-medium text-(--solus-text-secondary)"
              >This run</span
            >
            {#each runRows as row (row.label)}
              {@render statRow(row.label, row.value.toLocaleString())}
            {/each}
            {#if result && result.totalCostUsd > 0}
              {@render statRow("Cost", `$${result.totalCostUsd.toFixed(4)}`)}
            {/if}
          </div>
        {/if}
      </Popover.Content>
    </Popover.Root>
  </div>
{/if}
