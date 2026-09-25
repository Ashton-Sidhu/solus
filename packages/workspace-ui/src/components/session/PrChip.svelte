<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { ChevronDown as ChevronDownIcon, GitMerge as GitMergeIcon, GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import TaskPrMenuLabel from "./TaskPrMenuLabel.svelte";
  import { taskPrMenuTitle } from "./lib/task-pr-menu";
  import type { PrChip, PrChipState, TaskPrChoice } from "./lib/task-list";

  interface Props {
    chip: PrChip;
    choices: TaskPrChoice[];
    onOpen: (choice: TaskPrChoice) => void;
  }
  let { chip, choices, onOpen }: Props = $props();
  let menuOpen = $state(false);

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
      : chip.state === "unknown"
        ? `Pull request #${chip.number} — status unavailable`
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
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs text-(--pr-color) transition-[color,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          style:--pr-color={tone}
          aria-label={actionLabel}
          title={actionLabel}
          onkeydown={(event) => {
            event.stopPropagation();
            props.onkeydown?.(event);
          }}
          onpointerdown={(event) => {
            event.stopPropagation();
            props.onpointerdown?.(event);
          }}
          onclick={(event) => {
            event.stopPropagation();
            props.onclick?.(event);
          }}
        >
          {#if chip.state === "merged"}
            <GitMergeIcon size={12.5} class="shrink-0" />
          {:else}
            <GitPullRequestIcon size={12.5} weight={chip.state === "draft" ? "light" : "regular"} class="shrink-0" />
          {/if}
          <span class="tabular-nums">{chip.count} PRs</span>
          <ChevronDownIcon size={11} aria-hidden="true" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={7}
      class="w-80 min-w-0 max-w-[calc(100vw-2rem)] max-h-[min(24rem,var(--bits-dropdown-menu-content-available-height))] overscroll-contain text-workspace-chrome"
    >
      <DropdownMenu.Label class="text-workspace-chrome">Pull requests</DropdownMenu.Label>
      {#each choices as choice (`${choice.targetScope}:${choice.number}`)}
        <DropdownMenu.Item
          class="h-auto py-2 text-workspace-chrome"
          textValue={`#${choice.number} ${taskPrMenuTitle(choice)}`}
          title={`Open #${choice.number} ${taskPrMenuTitle(choice)}`}
          onclick={(event) => {
            event.stopPropagation();
            if (openChoiceExternal(choice, event)) menuOpen = false;
          }}
          onSelect={() => onOpen(choice)}
        >
          <TaskPrMenuLabel {choice} />
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <button
    type="button"
    class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs text-(--pr-color) transition-[color,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    style:--pr-color={tone}
    aria-label={actionLabel}
    title={actionLabel}
    onkeydown={(event) => event.stopPropagation()}
    onpointerdown={(event) => event.stopPropagation()}
    onclick={(event) => {
      event.stopPropagation();
      if (choices[0] && !openChoiceExternal(choices[0], event)) onOpen(choices[0]);
    }}
  >
    {#if chip.state === "merged"}
      <GitMergeIcon size={12.5} class="shrink-0" />
    {:else}
      <GitPullRequestIcon size={12.5} weight={chip.state === "draft" ? "light" : "regular"} class="shrink-0 {chip.state === 'draft' ? 'opacity-70' : ''}" />
    {/if}
    <span class="tabular-nums">#{chip.number}</span>
  </button>
{/if}
