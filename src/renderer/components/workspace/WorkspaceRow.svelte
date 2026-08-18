<script lang="ts">
  import {
    ArrowSquareOutIcon,
    AsteriskIcon,
    ChatCircleIcon,
    ColumnsIcon,
    FileTextIcon,
    GraphIcon,
    PresentationIcon,
    PushPinIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import {
    formatGeneratedDate,
    formatGeneratedFull,
    formatLedgerTime,
  } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";

  /** One ledger row — the same 44px rhythm for every artifact, pinned or not.
   *  Type is a coloured glyph, never a badge; status is a word in a fixed
   *  column, never a dot or a pill.
   *
   *  The row carries provenance rather than prose: the body is what the peek is
   *  for, so the space it used to take goes to the session that generated the
   *  artifact and the date it was generated on. */
  interface Props {
    item: WorkspaceItem;
    selected: boolean;
    /** Set while the ledger spans more than one project — the row then names
     *  the project it came from, which is otherwise implied by the scope. */
    showProject: boolean;
    /** Active free-text query, marked inside the title. */
    query: string;
    /** The origin session's name once the index has it; the chip stands in with
     *  a neutral word until then, and disappears where there is no session. */
    sessionLabel: string | null;
    onOpen: () => void;
    onTogglePin: () => void;
    /** Absent on plans — a plan is a session artifact and has no delete. */
    onDelete?: () => void;
    /** Opens the session the artifact came from. */
    onOpenSession?: () => void;
    /** Pins that same session into a companion pane instead. */
    onOpenSessionSplit?: () => void;
    /** Pointer resting here — the peek hangs off this element, not the cursor.
     *  Hovering never selects, so this is the whole of what hover does. */
    onPeek?: (row: HTMLElement) => void;
    onPeekLeave?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
  }

  let {
    item,
    selected,
    showProject,
    query,
    sessionLabel,
    onOpen,
    onTogglePin,
    onDelete,
    onOpenSession,
    onOpenSessionSplit,
    onPeek,
    onPeekLeave,
    onContextMenu,
  }: Props = $props();

  const statusLabel = $derived(
    item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1) : "",
  );
  const titleRuns = $derived(highlightRuns(item.title, query));
  const generated = $derived(formatGeneratedDate(item.createdAt));

  // 12px glyph in a 16px box. A plan wears its agent's logo — Claude's mark in
  // primary, Codex's in its own black — and the generic asterisk when the
  // provider is unknown.
  //
  // Works take the two Solus brand hues that carry no lifecycle meaning: teal
  // for written artifacts, dusty blue for drawn ones. Amber and sage are spoken
  // for elsewhere — they read as "needs you" and "done" on every other surface,
  // so a document must not wear them. Never filled, never duotone.
  const GLYPH_COLOR = {
    claude: "text-primary",
    plan: "text-primary",
    doc: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    slides: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    diagram: "text-[color-mix(in_oklch,var(--chart-5)_66%,var(--foreground))]",
    // Codex's mark is solid black, so it takes the white plate it wears
    // everywhere else in Solus rather than a text colour — that is what keeps
    // it legible in dark mode.
    codex: "",
  } as const;
</script>

<!-- Hover is the inset 999px wash so it composites over a selected row instead
     of replacing its fill; selection is --wash-2 and nothing else. Keyboard
     focus is the 1px inset ring at 45% primary every focused field takes. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="text-xs group flex h-11 cursor-pointer items-center gap-2 rounded-lg pr-3 pl-2.5 transition-shadow duration-150 select-none hover:shadow-[inset_0_0_0_999px_var(--wash-1)] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] focus-visible:outline-none {selected
 ? 'bg-[var(--wash-2)]'
 : ''}"
  data-selected={selected ? "true" : null}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onOpen}
  oncontextmenu={onContextMenu}
  onpointerenter={(e) => {
    if (e.pointerType === "mouse") onPeek?.(e.currentTarget as HTMLElement);
  }}
  onpointerleave={(e) => {
    if (e.pointerType === "mouse") onPeekLeave?.();
  }}
>
  <span
    class="flex w-4 shrink-0 items-center justify-center {GLYPH_COLOR[item.glyph]}"
    aria-hidden="true"
  >
    {#if item.glyph === "claude"}
      <ClaudeIcon size={14} />
    {:else if item.glyph === "codex"}
      <span class="flex size-4 items-center justify-center rounded-full bg-white">
        <OpenAIBlossom size={14} />
      </span>
    {:else if item.glyph === "plan"}
      <AsteriskIcon size={14} />
    {:else if item.glyph === "diagram"}
      <GraphIcon size={14} />
    {:else if item.glyph === "slides"}
      <PresentationIcon size={14} />
    {:else}
      <FileTextIcon size={14} />
    {/if}
  </span>

  <!-- Title and session split the row's slack 3:2 rather than the title taking
       all of it. Letting the title alone grow parked the whole tail against the
       right edge and opened a dead band across the middle of every row; sharing
       the growth closes that band and spends it on the one other column with
       prose in it. Ellipsis, never wraps. -->
  <span class="min-w-0 flex-[3] truncate text-sm font-normal ">
    {#each titleRuns as run, i (i)}{#if run.hit}<mark
          class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
          >{run.text}</mark
        >{:else}{run.text}{/if}{/each}
  </span>

  <!-- Where it came from: the session that generated the artifact. It reads as
       a field like every other — full colour, no chip — and only becomes two
       targets under the pointer, where "Open" and "Open in split" replace the
       chat glyph. It grows with the row instead of sitting at a fixed measure,
       because a session name is the one column here with prose in it — every
       other column holds a number or a single word. The cap keeps it from
       running away on an ultrawide window, where the name has long since fit. -->
  <span class="flex min-w-0 max-w-[26rem] flex-[2] items-center gap-[5px]">
    {#if item.sessionId}
      <ChatCircleIcon size={14} class="shrink-0 opacity-70" />
      <span class="min-w-0 flex-1 truncate" title={sessionLabel ?? undefined}>
        {sessionLabel ?? "Session"}
      </span>
      <!-- The two ways back in. The slot is reserved at rest, so the name has
           the same measure whether or not the pointer is here. -->
      <span
        class="flex w-11 shrink-0 justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {#if onOpenSession}
          <button
            type="button"
            class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] hover:text-foreground"
            onclick={(e) => {
              e.stopPropagation();
              onOpenSession();
            }}
            aria-label="Open session"
            title="Open session{sessionLabel ? ` — ${sessionLabel}` : ''}"
          >
            <ArrowSquareOutIcon size={14} />
          </button>
        {/if}
        {#if onOpenSessionSplit}
          <button
            type="button"
            class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] hover:text-foreground"
            onclick={(e) => {
              e.stopPropagation();
              onOpenSessionSplit();
            }}
            aria-label="Open session in split"
            title="Open session in split"
          >
            <ColumnsIcon size={14} />
          </button>
        {/if}
      </span>
    {/if}
  </span>

  <!-- Generated on: absolute, so it never reads as a second copy of the
       relative activity time at the row's end. -->
  <span
    class="w-[4.5rem] shrink-0 text-right"
    title={generated ? `Generated ${formatGeneratedFull(item.createdAt)}` : ""}
  >
    {generated}
  </span>

  <!-- Pin keeps the row's inner action slot: it is the row's own state, it is
       the frequent one, and it is harmless. On a pinned row it stays visible
       and turns primary; it is not filled in. Delete is not here — it sits at
       the far edge of the row, past status and time. -->
  <span class="flex shrink-0">
    <button
      type="button"
      class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-[background-color,color,opacity] duration-150 hover:bg-[var(--wash-3)] focus-visible:opacity-100 {item.pinned
 ? 'text-[color-mix(in_oklch,var(--primary)_78%,var(--foreground))] opacity-100'
 : 'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} {selected
 ? 'opacity-100'
 : ''}"
      onclick={(e) => {
        e.stopPropagation();
        onTogglePin();
      }}
      aria-label={item.pinned ? "Unpin" : "Pin"}
      title={item.pinned ? "Unpin (⌥P)" : "Pin (⌥P)"}
    >
      <PushPinIcon size={14} />
    </button>
  </span>

  {#if showProject}
    <span class="w-[4rem] shrink-0 truncate text-right" title={item.cwd}>
      {item.projectLabel}
    </span>
  {/if}

  <!-- Each trailing field is sized to the longest thing it can actually hold —
       "Jul 15, 2025", "Accepted", "Jul 15" — rather than to a shared column
       width. Right-aligned text in an oversized box pays for the slack on its
       left, which is what spread the tail across the row; matching the measure
       to the content pulls them back into one cluster. None of them is faded:
       these are the facts a person scans the ledger for, and the title leads on
       weight instead. Pending is the one coloured word — the one live state. -->
  <span
    class="w-[3.75rem] shrink-0 text-right {item.status ===
 'pending'
 ? 'font-medium text-[color-mix(in_oklch,var(--running)_62%,var(--foreground))]'
 : ''}"
  >
    {statusLabel}
  </span>
  <span
    class="w-[2.75rem] shrink-0 text-right tabular-nums"
    title="Last activity {formatGeneratedFull(item.timestamp)}"
  >
    {formatLedgerTime(item.timestamp)}
  </span>

  <!-- Delete lives past every column, at the row's outer edge — roughly 130px
       of status and time separate it from the pin, so the two can no longer be
       confused for one another under a moving cursor. The slot is reserved at
       rest rather than inserted on hover, so no column shifts when the trash
       appears, and it stays empty on plans, which have no delete. -->
  <span class="flex w-[22px] shrink-0 justify-end">
    {#if onDelete}
      <button
        type="button"
        class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-0 transition-[background-color,color,opacity] duration-150 group-focus-within:opacity-100 group-hover:opacity-60 hover:bg-[color-mix(in_oklch,var(--failure)_10%,transparent)] hover:text-[var(--failure)] hover:opacity-100! focus-visible:opacity-100 {selected
 ? 'opacity-60'
 : ''}"
        onclick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label="Delete document"
        title="Delete (⌥⌫)"
      >
        <TrashIcon size={14} />
      </button>
    {/if}
  </span>
</div>
