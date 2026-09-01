<script lang="ts">
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import {
    MAX_SHEETS,
    fanBox,
    sheetMarks,
    sheetPlacement,
    stackKicker,
    type DocumentStackEntry,
  } from "./lib/document-stack";
  import TaskLinkControl from "../tasks/link-control/TaskLinkControl.svelte";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";

  interface Props {
    entries: DocumentStackEntry[];
    linkContext?: TaskLinkContext;
    skipMotion?: boolean;
  }
  let { entries, linkContext, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();

  // Selection lives for the life of the card, not as a preference: the reader
  // picked a sheet in this turn, not a favourite.
  let selectedIndex = $state(0);
  let rowElements: Array<HTMLButtonElement | null> = [];

  const selected = $derived(entries[selectedIndex] ?? entries[0]);
  const box = $derived(fanBox(entries.length));
  // Marks are read off the preview once per work, not once per selection move:
  // picking a different sheet must not redraw the artwork on the others.
  const sheets = $derived(
    entries.slice(0, MAX_SHEETS).map((entry) => ({
      workId: entry.workId,
      streaming: entry.streaming,
      marks: sheetMarks(entry.preview),
    })),
  );
  const kicker = $derived(stackKicker(entries.map((entry) => entry.workType)));
  const writing = $derived(entries.some((entry) => entry.streaming));
  const lastEditedAt = $derived(
    entries.reduce((newest, entry) => {
      const at = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN;
      return Number.isNaN(at) ? newest : Math.max(newest, at);
    }, 0),
  );
  // The head states the count and when — never a written title, because the
  // stack names works, not an act.
  const head = $derived(
    writing
      ? `${entries.length} ${kicker} · writing`
      : `${entries.length} ${kicker}${lastEditedAt ? ` · ${relativeTime(lastEditedAt)}` : ""}`,
  );

  function open(entry: DocumentStackEntry | undefined) {
    if (entry) void session.openWorkModal(entry.workId, entry.title);
  }

  function openInSplit(entry: DocumentStackEntry | undefined) {
    if (entry) session.openWork(entry.workId, "aside");
  }

  function pick(index: number, event: MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      openInSplit(entries[index]);
      return;
    }
    // A second click on the sheet that is already forward opens it — reading one
    // work is one click, opening it is one more.
    if (index === selectedIndex) open(entries[index]);
    else selectedIndex = index;
  }

  function moveTo(index: number) {
    selectedIndex = index;
    rowElements[index]?.focus();
  }

  function handleRowKeydown(event: KeyboardEvent, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(Math.min(entries.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(Math.max(0, index - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(entries[index]);
    }
  }
</script>

<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <div
    class="document-stack @container mx-auto w-[88%] overflow-hidden rounded-2xl"
    data-testid="document-stack-card"
  >
    <div class="flex items-start gap-[1.125rem] p-4">
      <!-- Artwork, not a control: the fan says how many there are without
           spending a tile of width on each, and it is never a click target.
           A pane too narrow for it drops it rather than shrinking the index. -->
      <div
        class="relative shrink-0 @max-[24rem]:hidden"
        style="width:{box.width}px;height:{box.height}px"
        aria-hidden="true"
      >
        {#each sheets as sheet, index (sheet.workId)}
          {@const place = sheetPlacement(index, entries.length, selectedIndex)}
          <div
            class="document-stack__sheet absolute overflow-hidden rounded-[0.1875rem]"
            class:is-front={place.selected}
            class:is-pending={sheet.streaming}
            style="left:{place.left}px;top:{place.top}px;width:{place.width}px;height:{place.height}px;z-index:{place.zIndex};--sheet-rotation:{place.rotation.toFixed(
              1,
            )}deg"
          >
            <div class="flex flex-col gap-[0.25rem] p-[0.75rem_0.75rem_0]">
              {#each sheet.marks as mark, markIndex (markIndex)}
                <span
                  class="document-stack__mark rounded-[0.125rem]"
                  class:is-heading={mark.heading}
                  style="width:{mark.width}%"
                ></span>
              {/each}
            </div>
          </div>
        {/each}
      </div>

      <!-- The index keeps every title at full size in a straight column. -->
      <div class="flex min-w-0 flex-1 flex-col gap-px pt-0.5">
        <div class="document-stack__head mb-[0.4375rem]">{head}</div>
        {#each entries as entry, index (entry.workId)}
          <button
            type="button"
            bind:this={rowElements[index]}
            class="document-stack__row flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left"
            class:is-selected={index === selectedIndex}
            aria-current={index === selectedIndex}
            tabindex={index === selectedIndex ? 0 : -1}
            onclick={(event) => pick(index, event)}
            onkeydown={(event) => handleRowKeydown(event, index)}
          >
            {#if entry.streaming}
              <SpinnerIcon
                size={11}
                class="shrink-0 animate-spin text-(--muted-foreground)"
              />
            {/if}
            <span class="document-stack__name min-w-0 truncate">
              {entry.title}
            </span>
          </button>
        {/each}
      </div>
    </div>

    <div class="document-stack__rail flex items-center gap-1 px-2.5 py-2">
      <button
        type="button"
        class="document-stack__rail-action cursor-pointer rounded-md px-2 py-[0.3125rem]"
        onclick={() => openInSplit(selected)}
      >
        Open in split
      </button>
      <!-- The rail acts on the selected sheet, and so does its Link control:
           one control for the work in front, not one per title. -->
      {#if selected && !selected.streaming}
        {#key selected.workId}
          <TaskLinkControl
            target={{ kind: "work", targetScope: "", targetKey: selected.workId }}
            title={selected.title}
            serverId={linkContext?.serverId}
            projectKey={linkContext?.projectKey}
            conversationTaskId={linkContext?.conversationTaskId}
          />
        {/key}
      {/if}
      <span class="flex-1"></span>
      <button
        type="button"
        class="document-stack__open flex h-7 max-w-[14rem] shrink-0 cursor-pointer items-center gap-1 overflow-hidden rounded-lg px-3"
        onclick={() => open(selected)}
      >
        <span class="shrink-0">Open</span>
        <span class="min-w-0 truncate opacity-70">{selected?.title ?? ""}</span>
      </button>
    </div>
  </div>
</div>

<style>
  /* Same shell as ConversationRefCard, so a stack and a single card read as the
     same object in the transcript. */
  .document-stack {
    background: var(--solus-tx-card-bg);
    box-shadow: var(--solus-tx-card-shadow);
  }

  /* A sheet is paper, not a white rectangle: it mixes off the card so it never
     burns bright on a dark canvas. */
  .document-stack__sheet {
    background: color-mix(in oklch, var(--card) 96%, var(--foreground) 2%);
    box-shadow:
      0 0 0 0.03125rem color-mix(in oklch, var(--foreground) 12%, transparent),
      0 0.25rem 0.625rem -0.5rem rgb(0 0 0 / 0.24);
    transform: rotate(var(--sheet-rotation));
    transition:
      transform var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }

  /* Selection changes a transform and a shadow and nothing else — the fan never
     re-lays out, so moving the selection reflows nothing. */
  .document-stack__sheet.is-front {
    transform: rotate(var(--sheet-rotation)) translateY(-0.375rem) scale(1.03);
    box-shadow:
      0 0 0 0.03125rem color-mix(in oklch, var(--foreground) 14%, transparent),
      0 0.625rem 1.375rem -0.625rem rgb(0 0 0 / 0.34);
  }

  /* The name appears the moment the work opens; its sheet waits for the first
     paragraph rather than drawing marks it does not have. */
  .document-stack__sheet.is-pending {
    opacity: 0.35;
  }

  .document-stack__mark {
    height: 0.1875rem;
    background: color-mix(in oklch, var(--foreground) 15%, transparent);
  }

  .document-stack__mark.is-heading {
    height: 0.3125rem;
    background: color-mix(in oklch, var(--foreground) 44%, transparent);
  }

  .document-stack__head {
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .document-stack__row {
    border: none;
    background: transparent;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .document-stack__row:hover {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
  }

  .document-stack__row.is-selected {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in oklch, var(--foreground) 10%, transparent);
  }

  .document-stack__row:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: -0.0625rem;
  }

  .document-stack__name {
    font-size: var(--text-transcript-card);
    font-weight: 500;
    color: var(--solus-text-primary);
  }

  .document-stack__rail {
    border-top: 0.0625rem solid var(--solus-tx-rule);
  }

  .document-stack__rail-action,
  .document-stack__open {
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }

  .document-stack__open {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
  }

  .document-stack__rail-action:hover {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
  }

  .document-stack__open:hover {
    background: color-mix(in oklch, var(--foreground) 11%, transparent);
    color: var(--solus-text-primary);
  }

  .document-stack__rail-action:active,
  .document-stack__open:active {
    transform: scale(0.96);
  }

  .document-stack__rail-action:focus-visible,
  .document-stack__open:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .document-stack__sheet {
      transition: none;
    }
  }
</style>
