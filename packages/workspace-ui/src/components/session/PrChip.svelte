<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { ChevronDown as ChevronDownIcon, GitPullRequest as GitPullRequestIcon, X as XIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { hoverIntent } from "../../lib/hover-intent";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { prStatusBadge, REQUIRED_CHECKS_FAILING_BADGE } from "../prs/lib/pr-utils";
  import TaskPrMenuLabel from "./TaskPrMenuLabel.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import { taskPrMenuTitle } from "./lib/task-pr-menu";
  import { taskStatusFor, type PrChip, type TaskPrChoice } from "./lib/task-list";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";

  interface Props {
    chip: PrChip;
    choices: TaskPrChoice[];
    onOpen: (choice: TaskPrChoice) => void;
    /** Opens the pull request's own menu. With several pull requests, the
     *  chip opens its list. */
    onMore?: (event: MouseEvent, choice: TaskPrChoice) => void;
    /** Reads the pull request ahead while the pointer rests on the chip, so
     *  the click finds it loaded. */
    onWarm?: (choice: TaskPrChoice) => void;
    /** Removes a link from the row. Absent for a pull request the row only
     *  reads from its checkout, which has no link to remove. */
    onUnlink?: (choice: TaskPrChoice) => (() => void) | null;
    /** The sessions the row's session started. The chip lists them under its
     *  pull requests, so a row spends one chip on everything it links to. */
    startedSessions?: SidebarSessionChild[];
    onOpenSession?: (session: SidebarSessionChild) => void;
  }
  let { chip, choices, onOpen, onMore, onWarm, onUnlink, startedSessions = [], onOpenSession }: Props = $props();
  let menuOpen = $state(false);

  // The chip shows the pull request that leads, and a menu when there is
  // more behind it: another pull request or a started session.
  const hasMenu = $derived(chip.count > 1 || startedSessions.length > 0);
  const moreCount = $derived(chip.count - 1 + startedSessions.length);

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
    hasMenu
      ? `${label}, and ${moreCount} more linked ${moreCount === 1 ? "item" : "items"}. Choose one.`
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
{#if hasMenu}
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
          <span class="tabular-nums">#{chip.number}</span>
          <span class="tabular-nums text-muted-foreground">+{moreCount}</span>
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
        {@const unlink = onUnlink?.(choice) ?? null}
        <!-- Delete or Backspace unlinks the highlighted row, so the keyboard
             needs no second stop. -->
        <DropdownMenu.Item
          class="group/pr text-workspace-chrome"
          textValue={`#${choice.number} ${taskPrMenuTitle(choice)}`}
          title={`Open #${choice.number} ${taskPrMenuTitle(choice)}`}
          onclick={(event) => {
            event.stopPropagation();
            if (openChoiceExternal(choice, event)) menuOpen = false;
          }}
          onkeydown={(event) => {
            if (!unlink || (event.key !== "Delete" && event.key !== "Backspace")) return;
            event.preventDefault();
            unlink();
          }}
          onSelect={() => onOpen(choice)}
        >
          <TaskPrMenuLabel {choice} />
          {#if unlink}
            <Button
              variant="ghost"
              size="icon-xs"
              tabindex={-1}
              class="-my-1 -mr-1 size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover/pr:opacity-100 group-data-highlighted/pr:opacity-100 hover:text-foreground pointer-coarse:opacity-100"
              aria-label={`Unlink pull request #${choice.number}`}
              title="Unlink"
              onpointerdown={(event) => event.stopPropagation()}
              onclick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                unlink();
              }}
            >
              <XIcon size={12} aria-hidden="true" />
            </Button>
          {/if}
        </DropdownMenu.Item>
      {/each}
      {#if startedSessions.length > 0}
        <DropdownMenu.Separator />
        <DropdownMenu.Label class="text-workspace-chrome">Sessions it started</DropdownMenu.Label>
        {#each startedSessions as session (session.tabId ?? session.sessionId)}
          <DropdownMenu.Item
            class="text-workspace-chrome"
            textValue={session.label}
            title={`Open ${session.label}`}
            onclick={(event) => event.stopPropagation()}
            onSelect={() => onOpenSession?.(session)}
          >
            <TaskStatusGlyph
              status={taskStatusFor(session.attention)}
              size={13}
              label={attentionLabel(session.attention, session.limitResetsAt)}
            />
            <span class="min-w-0 flex-1 truncate">{session.label}</span>
          </DropdownMenu.Item>
        {/each}
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <button
    type="button"
    class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs text-(--pr-color) transition-[color,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    style:--pr-color={tone}
    aria-label={actionLabel}
    title={actionLabel}
    {@attach onWarm && choices[0] ? hoverIntent(() => onWarm(choices[0])) : undefined}
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
