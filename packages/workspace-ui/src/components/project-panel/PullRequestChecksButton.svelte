<script lang="ts">
  import type { PrChecksSummary } from "@solus/contracts/checks-types";
  import { localApi } from "@solus/client-core/local-api";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { checkResultLabel, isFailing, type ChecksPresentation } from "../prs/lib/checks";
  import { CHECKS_ICON, checkItemIcon } from "../prs/lib/checks-icons";
  import * as Popover from "../ui/popover";
  import { checksButtonLabel, checksPopover } from "./lib/linked-pull-request-row";

  // The checks of the session's pull request, on the second line of its row:
  // the glyph and a count, and a popover that lists what needs a look first.
  interface Props {
    checks: ChecksPresentation;
    summary: PrChecksSummary | undefined;
    /** Open the pull request pane where its checks are. */
    onOpenChecks: () => void;
  }
  let { checks, summary, onOpenChecks }: Props = $props();

  let open = $state(false);
  let showAll = $state(false);
  const label = $derived(checksButtonLabel(checks, summary));
  const Glyph = $derived(CHECKS_ICON[checks.state]);
  const popover = $derived(checksPopover(summary));
  const shown = $derived([
    ...popover.attention,
    ...popover.running,
    ...(showAll || !popover.foldsCompleted ? popover.completed : []),
  ]);
</script>
  <Popover.Root
    bind:open
    onOpenChange={(next) => {
      if (!next) requestInputFocus();
    }}
  >
    <Popover.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="inline-flex h-[1.375rem] min-w-0 shrink cursor-pointer items-center gap-1 overflow-hidden rounded-md border-none bg-transparent px-1.5 text-inherit transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-expanded:bg-(--solus-surface-hover) aria-expanded:text-(--solus-text-primary)"
          aria-label={`Checks: ${checks.label}`}
        >
          <span
            class="inline-flex shrink-0 {checks.state === 'failing'
              ? 'text-(--solus-status-error)'
              : checks.state === 'passing'
                ? 'text-(--solus-status-complete)'
                : checks.state === 'pending'
                  ? 'text-(--solus-status-running)'
                  : 'text-(--solus-text-tertiary)'}"><Glyph size={14} /></span>
          {#if label}<span class="min-w-0 truncate tabular-nums">{label}</span>{/if}
        </button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      class="w-[min(18rem,calc(100vw-2rem))] gap-2 text-xs lg:text-xs"
    >
      <div>
        <div class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">{popover.heading}</div>
        {#if checks.stale || checks.state === "unavailable"}
          <div class="mt-0.5 text-(--solus-text-tertiary)">{checks.tooltip}</div>
        {:else if popover.summary}
          <div class="mt-0.5 text-(--solus-text-tertiary)">{popover.summary}</div>
        {/if}
      </div>
      {#if shown.length}
        <ul class="grid max-h-64 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 overflow-y-auto">
          {#each shown as check (check.id)}
            {@const CheckIcon = checkItemIcon(check)}
            <li class="col-span-full grid grid-cols-subgrid items-center">
              <span
                class="inline-flex {isFailing(check)
                  ? 'text-(--solus-status-error)'
                  : check.inFlight
                    ? 'text-(--solus-status-running)'
                    : check.conclusion === 'success'
                      ? 'text-(--solus-status-complete)'
                      : 'text-(--solus-text-tertiary)'}"><CheckIcon size={14} /></span
              >
              <span class="min-w-0 truncate text-(--solus-text-primary)" title={check.description ?? check.name}
                >{check.name}</span
              >
              <span class="justify-self-end whitespace-nowrap text-(--solus-text-tertiary)">{checkResultLabel(check)}</span>
              {#if check.detailsUrl}
                {@const detailsUrl = check.detailsUrl}
                <button
                  type="button"
                  class="cursor-pointer border-none bg-transparent p-0 text-(--solus-accent) hover:underline"
                  onclick={() => void localApi.openExternal(detailsUrl)}>Details</button
                >
              {:else}
                <span></span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <div class="flex items-center gap-3">
        {#if popover.foldsCompleted}
          <button
            type="button"
            class="cursor-pointer border-none bg-transparent p-0 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
            aria-expanded={showAll}
            onclick={() => (showAll = !showAll)}>{showAll ? "Show less" : "Show all"}</button
          >
        {/if}
        <button
          type="button"
          class="ml-auto cursor-pointer border-none bg-transparent p-0 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          onclick={() => {
            open = false;
            onOpenChecks();
          }}>Open checks</button
        >
      </div>
    </Popover.Content>
  </Popover.Root>
