<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { ChevronDown as ChevronDownIcon, GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { prStatusBadge, REQUIRED_CHECKS_FAILING_BADGE } from "../prs/lib/pr-utils";
  import TaskPrMenuLabel from "./TaskPrMenuLabel.svelte";
  import { taskPrMenuTitle } from "./lib/task-pr-menu";
  import type { PrChip, TaskPrChoice } from "./lib/task-list";

  interface Props {
    chip: PrChip;
    choices: TaskPrChoice[];
    onOpen: (choice: TaskPrChoice) => void;
    /** Opens the pull request's own menu. With several pull requests, the
     *  chip opens its list. */
    onMore?: (event: MouseEvent, choice: TaskPrChoice) => void;
  }
  let { chip, choices, onOpen, onMore }: Props = $props();
  let menuOpen = $state(false);

  // The menu's rows and the PR surfaces draw each state with these badges, so
  // the chip takes its tone and icon from them too. Review requests use a
  // purple attention tone; a state not known yet stays neutral.
  const badge = $derived(
    chip.state === "checksFailing"
      ? REQUIRED_CHECKS_FAILING_BADGE
      : chip.state === "approvalRequested" || chip.state === "unknown"
        ? null
        : prStatusBadge({ state: chip.state === "draft" ? "open" : chip.state, draft: chip.state === "draft" }),
  );
  const tone = $derived(
    chip.state === "approvalRequested"
      ? "color-mix(in oklch, var(--review) 58%, var(--foreground))"
      : (badge?.tone ?? "var(--muted-foreground)"),
  );
  const StateIcon = $derived(badge?.Icon ?? GitPullRequestIcon);

  const label = $derived(
    chip.state === "approvalRequested"
      ? `Pull request #${chip.number} — your review requested`
      : chip.state === "checksFailing"
        ? `Pull request #${chip.number} — required checks failing`
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
          oncontextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            menuOpen = true;
          }}
        >
          <StateIcon size={12.5} class="shrink-0" />
          <span class="tabular-nums">{chip.count} PRs</span>
          <ChevronDownIcon size={11} aria-hidden="true" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={7}
      class="w-72 min-w-0 max-w-[calc(100vw-2rem)] max-h-[min(20rem,var(--bits-dropdown-menu-content-available-height))] overscroll-contain text-workspace-chrome"
    >
      <DropdownMenu.Label class="text-workspace-chrome">Pull requests</DropdownMenu.Label>
      {#each choices as choice (`${choice.targetScope}:${choice.number}`)}
        <DropdownMenu.Item
          class="text-workspace-chrome"
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
    oncontextmenu={(event) => {
      if (!onMore || !choices[0]) return;
      event.preventDefault();
      event.stopPropagation();
      onMore(event, choices[0]);
    }}
  >
    <StateIcon size={12.5} class="shrink-0" />
    <span class="tabular-nums">#{chip.number}</span>
  </button>
{/if}
