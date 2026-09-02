<script lang="ts">
  import { untrack } from "svelte";
  import { Pin as PushPinIcon, Trash2 as TrashIcon } from "@lucide/svelte";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import { formatPeekAge } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";
  import { peekBody, peekBox, peekOutline } from "./lib/workspace-peek";
  import { parseDiagram, summarizeDiagram } from "@solus/contracts/diagram-types";
  import { getWorkspaceContext, getPlanStore } from "../../contexts";
  import { portal } from "../portal";
  import { BottomSheet } from "../ui/bottom-sheet";

  /** The hover peek: a transient card hanging off the row's title column.
   *  Nothing is reserved and nothing is clicked — it exists only while the
   *  pointer rests, and it reads; it never edits.
   *
   *  It is detached furniture, so it takes the app's popover surface — border,
   *  fill and drop shadow together — rather than the flat ring the ledger's own
   *  wells use. Without all three it lies flat against the rows behind it.
   *
   *  ── The sheet form ──
   *  A finger cannot rest, so on a stacked pane there is no hover to hang this
   *  off. The same card is raised from the bottom instead, with the row's title
   *  restated (the sheet covers the row the card used to sit beside) and the
   *  keyboard hint replaced by the button it was describing. It stays a
   *  preview: dismissing returns to the ledger at the same scroll position, and
   *  Open is the only thing in it that navigates. */
  interface Props {
    item: WorkspaceItem;
    /** The row the card is anchored to. Null in the sheet, which is anchored to
     *  the screen rather than to a row. */
    anchor?: HTMLElement | null;
    /** The scroll area the card is clamped inside. Unused by the sheet. */
    ledger?: HTMLElement | null;
    /** Active free-text query — the body shows the passage that matched. */
    query: string;
    /** ⇧ held, or opened from the keyboard: the card takes pointer events. */
    pinned: boolean;
    variant?: "card" | "sheet";
    /** Sheet only — the one thing in it that navigates. */
    onOpen?: () => void;
    /** Sheet only. The record row drops the pin a pointer would have revealed,
     *  so this sheet is where pinning and unpinning live on a phone. */
    onTogglePin?: () => void;
    /** Sheet only, and works only — a plan is a session artifact and has no
     *  delete, so the slot stays empty rather than showing a dead control. */
    onDelete?: () => void;
    onClose?: () => void;
  }

  let {
    item,
    anchor = null,
    ledger = null,
    query,
    pinned,
    variant = "card",
    onOpen,
    onTogglePin,
    onDelete,
    onClose,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();

  const KIND_LABELS = { plan: "Plan", doc: "Doc", diagram: "Diagram" } as const;

  // The artifact's own text, loaded once the card is already open. Until it
  // lands the ledger snippet stands in — a hover card never shows a spinner.
  let loadedContent = $state<{ id: string; content: string } | null>(null);

  $effect(() => {
    const current = item;
    if (untrack(() => loadedContent?.id) === current.id) return;
    void loadContent(current);
  });

  async function loadContent(target: WorkspaceItem) {
    if (target.source.kind === "work") {
      const work = await session.worksStore.ensureContent(
        target.id,
        "workspace-peek",
      );
      if (work) loadedContent = { id: target.id, content: work.content };
      return;
    }
    await session.loadPlanContent(target.source.descriptor);
    loadedContent = {
      id: target.id,
      content: planStore.get(target.id)?.content ?? "",
    };
  }

  const content = $derived(
    loadedContent?.id === item.id ? loadedContent.content : null,
  );
  const contentReady = $derived(loadedContent?.id === item.id);
  const body = $derived(peekBody(item, content, query));
  const bodyRuns = $derived(highlightRuns(body, query));
  const outline = $derived(peekOutline(item, content));
  /** Counts are not structure — on a diagram they ride the meta line. */
  const diagramCounts = $derived.by(() => {
    if (item.type !== "diagram" || !content) return "";
    try {
      return summarizeDiagram(parseDiagram(content));
    } catch {
      return "";
    }
  });
  const statusLabel = $derived(
    item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1) : "",
  );

  function projectShort(cwd: string): string {
    const dir = cwd?.replace(/\/$/, "");
    if (!dir || dir === "~") return "~";
    return dir.split("/").at(-1) || "~";
  }

  // ── Anchoring ──
  // The card only; the sheet is positioned by the viewport and needs none of
  // this, which is why the measurement is skipped rather than thrown away.
  let height = $state(0);
  const box = $derived.by(() => {
    // Measured height decides whether the card flips, so it is a dependency of
    // the box, not an afterthought applied to it.
    const h = height;
    void item.id;
    if (!anchor || !ledger) return { left: 0, top: 0, width: 0 };
    return peekBox(
      anchor.getBoundingClientRect(),
      ledger.getBoundingClientRect(),
      h,
    );
  });
  /** Placed only once it has been measured — a card that paints below the row
   *  and then flips above it reads as a glitch. */
  const placed = $derived(height > 0);
</script>

{#snippet peekBodyBlock()}
  <!-- Kind · origin · age, then the plan's status word in its own colour. The
       title is not repeated — it is two pixels above, in the row. -->
  <div class="flex items-center gap-2 text-muted-foreground">
    <span class="text-xs font-normal uppercase">
      {KIND_LABELS[item.type]}
    </span>
    <span class="opacity-35" aria-hidden="true">·</span>
    <span class="truncate opacity-85" title={item.cwd}>
      {projectShort(item.cwd)}
    </span>
    <span class="opacity-35" aria-hidden="true">·</span>
    <span class="shrink-0">{formatPeekAge(item.timestamp)}</span>
    {#if statusLabel}
      <span class="opacity-35" aria-hidden="true">·</span>
      <span
        class="shrink-0 {item.status === 'pending'
 ? 'font-medium text-[color-mix(in_oklch,var(--running)_62%,var(--foreground))]'
 : ''}"
      >
        {statusLabel}
      </span>
    {/if}
    {#if diagramCounts}
      <span class="opacity-35" aria-hidden="true">·</span>
      <span class="truncate">{diagramCounts}</span>
    {/if}
  </div>

  {#if item.type === "diagram"}
    <!-- The one place imagery appears: the graph fit to the card's width, in
         place of the body. The frame is reserved at rest rather than inserted
         when the JSON lands, so the card does not jump its own height — and it
         holds an empty wash, never a spinner. -->
    <div class="h-[240px] overflow-hidden rounded-lg bg-[var(--wash-1)]">
      {#if content}
        {#await import("../diagram/DiagramThumbnail.svelte") then thumbModule}
          {@const DiagramThumbnail = thumbModule.default}
          <DiagramThumbnail {content} />
        {/await}
      {/if}
    </div>
  {:else if body}
    <div class="peek-body leading-[1.6] text-muted-foreground text-pretty">
      {#each bodyRuns as run, i (i)}{#if run.hit}<mark
            class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
            >{run.text}</mark
          >{:else}{run.text}{/if}{/each}
    </div>
  {/if}

  <div class="h-px bg-[var(--hairline)]" aria-hidden="true"></div>

  <div class="flex gap-[22px]">
    <div class="flex flex-1 flex-col gap-[5px]">
      {#each outline.lines as line (line.n)}
        <span class="flex items-baseline gap-2 leading-[1.4]">
          <span
            class="tabular-nums text-muted-foreground opacity-70"
            >{line.n}</span
          >
          <span
            class="truncate text-[color-mix(in_oklch,var(--foreground)_74%,transparent)]"
            >{line.text}</span
          >
        </span>
      {/each}
      {#if outline.more > 0}
        <span class="pl-[26px] leading-[1.4] text-muted-foreground">
          +{outline.more} more
        </span>
      {/if}
    </div>
    <!-- Text, not keycaps: keycaps at this size in a transient card read as
         clickable, and nothing in here is. The sheet has a real button for
         this instead, so it says nothing about keys it has none of. -->
    {#if variant === "card"}
      <span
        class="shrink-0 self-end text-muted-foreground opacity-75"
      >
        ⏎ open · ⇧ hold to pin open
      </span>
    {/if}
  </div>
{/snippet}

{#if variant === "sheet"}
  <BottomSheet label={item.title} onClose={() => onClose?.()}>
    {#snippet header()}
      <!-- The sheet covers the row it was raised from, so unlike the card it
           has to say which artifact this is. -->
      <div class="text-workspace-chrome font-medium text-pretty text-foreground">
        {item.title}
      </div>
    {/snippet}
    <div class="text-xs flex flex-col gap-2" data-testid="workspace-peek">
      {@render peekBodyBlock()}
    </div>
    {#snippet footer()}
      <!-- Open is the row's tap, restored: the tap that would have opened the
           artifact on a wide pane raised this sheet instead, so the sheet has to
           carry it. Pin and delete flank it at the same height — the record row
           has neither, and a state you can enter needs a way back out. -->
      <div class="flex gap-[9px]">
        <button
          type="button"
          class="h-[50px] flex-1 rounded-lg border-0 bg-primary font-semibold text-primary-foreground [-webkit-tap-highlight-color:transparent] disabled:cursor-wait disabled:opacity-60 {contentReady
            ? 'cursor-pointer'
            : 'cursor-wait'}"
          onclick={contentReady ? onOpen : undefined}
          disabled={!contentReady}
        >
          {contentReady
            ? `Open ${KIND_LABELS[item.type].toLowerCase()}`
            : `Loading ${KIND_LABELS[item.type].toLowerCase()}…`}
        </button>
        {#if onTogglePin}
          <button
            type="button"
            class="flex size-[50px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent] {item.pinned
 ? 'text-[color-mix(in_oklch,var(--primary)_78%,var(--foreground))]'
 : 'text-foreground'}"
            onclick={onTogglePin}
            aria-pressed={item.pinned}
            aria-label={item.pinned ? "Unpin" : "Pin"}
          >
            <PushPinIcon size={18} />
          </button>
        {/if}
        {#if onDelete}
          <button
            type="button"
            class="flex size-[50px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-[var(--wash-2)] text-muted-foreground [-webkit-tap-highlight-color:transparent]"
            onclick={onDelete}
            aria-label="Delete document"
          >
            <TrashIcon size={18} />
          </button>
        {/if}
      </div>
    {/snippet}
  </BottomSheet>
{:else}
  <div
    use:portal={document.body}
    bind:clientHeight={height}
    class="text-xs fixed z-50 flex flex-col gap-2 rounded-2xl border border-[var(--solus-popover-border)] bg-[var(--solus-popover-bg)] p-[12px_14px_11px] text-left shadow-[shadow:var(--solus-popover-shadow)] backdrop-blur-[14px] {placed
 ? 'peek-in'
 : 'invisible'} {pinned ? '' : 'pointer-events-none'}"
    style="left:{box.left}px; top:{box.top}px; width:{box.width}px"
    role="tooltip"
    data-testid="workspace-peek"
  >
    {@render peekBodyBlock()}
  </div>
{/if}

<style>
  /* Three lines, then it stops — the card is a reference to a page, not the
     page. */
  .peek-body {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* First open only. Swapping rows keeps the element mounted, so the card never
     re-animates as the pointer walks the ledger. */
  .peek-in {
    animation: peek-pop 0.16s ease-out;
  }
  @keyframes peek-pop {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .peek-in {
      animation: peek-fade 0.16s ease-out;
    }
    @keyframes peek-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  }
</style>
