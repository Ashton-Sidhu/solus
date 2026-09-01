<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { GitMerge as GitMergeIcon, GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { prChipState, type PrChip, type PrChipState, type TaskPrChoice } from "./lib/task-list";

  interface Props {
    chip: PrChip;
    choices: TaskPrChoice[];
    onOpen: (choice: TaskPrChoice) => void;
  }
  let { chip, choices, onOpen }: Props = $props();

  // Match Git host conventions: open is green and merged is purple. Review
  // requests also use purple as an attention state; drafts stay neutral.
  function toneFor(state: PrChipState): string {
    switch (state) {
      case "approvalRequested":
        return "color-mix(in oklch, var(--review) 58%, var(--foreground))";
      case "merged":
        return "var(--review)";
      case "open":
        return "var(--success)";
      case "closed":
        return "var(--solus-status-error)";
      default:
        return "var(--muted-foreground)";
    }
  }

  const tone = $derived(toneFor(chip.state));

  const label = $derived(
    chip.state === "approvalRequested"
      ? `Pull request #${chip.number} — your review requested`
      : `Pull request #${chip.number} — ${chip.state}`,
  );
  const actionLabel = $derived(
    chip.count > 1
      ? `${chip.count} linked pull requests. Choose a pull request.`
      : `${label}. View pull request.`,
  );

  function openChoiceExternal(choice: TaskPrChoice, event: MouseEvent): boolean {
    const url = choice.url ?? choice.pullRequest?.url;
    if (!event.metaKey || !url) return false;

    event.preventDefault();
    void localApi.openExternal(url);
    return true;
  }
</script>

<!-- The chip pads its own hit target because the glyph and number are small.
     The padding grows sideways, where the chip has the row's slack to itself,
     and stays tight vertically: the sidebar stacks the chip directly under the
     task's hover actions, and a target that reached up into them turned a click
     on close or complete into a trip to the pull request. -->
{#if chip.count > 1}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs text-(--pr-color) transition-[color,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-fine:[.is-laptop-display_&]:gap-0.5"
          style:--pr-color={tone}
          aria-label={actionLabel}
          title={actionLabel}
          onclick={(event) => {
            event.stopPropagation();
            if (choices[0] && openChoiceExternal(choices[0], event)) return;
            props.onclick?.(event);
          }}
        >
          {#if chip.state === "merged"}
            <GitMergeIcon size={12.5} class="shrink-0 pointer-fine:[.is-laptop-display_&]:size-3" />
          {:else}
            <GitPullRequestIcon size={12.5} weight={chip.state === "draft" ? "light" : "regular"} class="shrink-0 pointer-fine:[.is-laptop-display_&]:size-3" />
          {/if}
          <span class="tabular-nums">#{chip.number} +{chip.count - 1}</span>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={7} class="w-[min(22rem,calc(100vw-1rem))]">
      {#each choices as choice (`${choice.targetScope}:${choice.number}`)}
        {@const state = choice.pullRequest ? prChipState(choice.pullRequest) : "open"}
        <DropdownMenu.Item onSelect={() => onOpen(choice)}>
          <span class="flex size-4 shrink-0 items-center justify-center" style="color:{toneFor(state)}">
            {#if state === "merged"}
              <GitMergeIcon size={13} />
            {:else}
              <GitPullRequestIcon size={13} weight={state === "draft" ? "light" : "regular"} />
            {/if}
          </span>
          <span class="shrink-0 tabular-nums text-muted-foreground">#{choice.number}</span>
          <span class="min-w-0 flex-1 truncate">{choice.title}</span>
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <button
    type="button"
    class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs text-(--pr-color) transition-[color,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-fine:[.is-laptop-display_&]:gap-0.5"
    style:--pr-color={tone}
    aria-label={actionLabel}
    title={actionLabel}
    onclick={(event) => {
      event.stopPropagation();
      if (choices[0] && !openChoiceExternal(choices[0], event)) onOpen(choices[0]);
    }}
  >
    {#if chip.state === "merged"}
      <GitMergeIcon size={12.5} class="shrink-0 pointer-fine:[.is-laptop-display_&]:size-3" />
    {:else}
      <GitPullRequestIcon size={12.5} weight={chip.state === "draft" ? "light" : "regular"} class="shrink-0 pointer-fine:[.is-laptop-display_&]:size-3 {chip.state === 'draft' ? 'opacity-70' : ''}" />
    {/if}
    <span class="tabular-nums">#{chip.number}</span>
  </button>
{/if}
