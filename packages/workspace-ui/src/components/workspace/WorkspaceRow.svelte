<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    MessageCircle as ChatCircleIcon,
    Columns3 as ColumnsIcon,
    FileText as FileTextIcon,
    Network as ArchitectureIcon,
    AppWindow as ArtifactIcon,
    Presentation as PresentationIcon,
    Cloud as CloudIcon,
    Pin as PushPinIcon,
    Clock as ClockIcon,
    Eye as EyeIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import DocProviderLogo from "../work/DocProviderLogo.svelte";
  import ReviewerAvatars from "../work/ReviewerAvatars.svelte";
  import { PR_CHECKS_TONE, PR_STATUS_TONE } from "../prs/lib/pr-row-styles";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import {
    formatGeneratedDate,
    rowStatus,
    formatGeneratedFull,
    formatLedgerTime,
    upstreamProviderFor,
  } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";
  import PresenceStack from "../presence/PresenceStack.svelte";
  import type { PresencePerson } from "../presence/lib/presence-people";

  /** One ledger row — the same 44px rhythm for every artifact, pinned or not.
   *  Type is a coloured glyph, never a badge; status is an icon in a fixed
   *  column, never a dot or a pill.
   *
   *  The row carries provenance rather than prose: the body is what the peek is
   *  for, so the space it used to take goes to the session that generated the
   *  artifact and the date it was generated on.
   *
   *  ── The record rung (`@max-[30rem]/pane`) ──
   *  Below 30rem the columns stop being columns and the row becomes one record:
   *
   *    glyph │ title
   *          │ snippet — unpinned rows only
   *          │ scope ······················· status · age
   *
   *  It is a two-column grid rather than a wrapping row, so lines two and three
   *  hang under the title instead of under the glyph.
   *
   *  The snippet comes back here precisely because the peek does not: hover has
   *  no touch equivalent, so the body a pointer would have revealed is spent on
   *  the row instead. A pinned row drops it, where the title is already the
   *  reason the row was pinned.
   *
   *  Everything a pointer reveals — pin, delete, and the two ways back into the
   *  origin session — leaves the record. A finger cannot hover, so each would
   *  have to become a permanent target crowding the one target that matters;
   *  they live in the peek sheet the tap raises instead. */
  interface Props {
    item: WorkspaceItem;
    selected: boolean;
    /** Set while the ledger holds more than one project — the row then names
     *  the project it came from. */
    showProject: boolean;
    /** "Solus Cloud" when the artifact's home is the workspace service; null for this machine's. */
    homeLabel?: string | null;
    /** Active free-text query, marked inside the title. */
    query: string;
    /** The origin session's name once the index has it; the chip stands in with
     *  a neutral word until then, and disappears where there is no session. */
    sessionLabel: string | null;
    onOpen: () => void;
    onTogglePin: () => void;
    /** Absent where the reader may not delete the work. */
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
    /** Works only: the people who have this work open now; "editing…" under whoever changes it. */
    present?: PresencePerson[];
  }

  let {
    present = [],
    item,
    selected,
    showProject,
    homeLabel = null,
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

  const status = $derived(rowStatus(item));
  const titleRuns = $derived(highlightRuns(item.title, query));
  const generated = $derived(formatGeneratedDate(item.createdAt));
  const upstreamProvider = $derived(upstreamProviderFor(item));

  // 12px glyph in a 16px box. Works take the two Solus brand hues that carry no lifecycle meaning: teal
  // for written artifacts, dusty blue for drawn ones. Amber and sage are spoken
  // for elsewhere — they read as "needs you" and "done" on every other surface,
  // so a document must not wear them. Never filled, never duotone.
  const GLYPH_COLOR = {
    doc: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    slides: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    diagram: "text-[color-mix(in_oklch,var(--chart-5)_66%,var(--foreground))]",
    // An artifact is drawn, not written, so it takes the diagram's hue.
    artifact: "text-[color-mix(in_oklch,var(--chart-5)_66%,var(--foreground))]",
  } as const;
</script>

<!-- Hover is the inset 999px wash so it composites over a selected row instead
     of replacing its fill; selection is --wash-2 and nothing else. Keyboard
     focus is the 1px inset ring at 45% primary every focused field takes. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="text-xs group flex h-11 cursor-pointer items-center gap-2 rounded-lg pr-3 pl-2.5 transition-shadow duration-150 select-none hover:shadow-[inset_0_0_0_999px_var(--wash-1)] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] focus-visible:outline-none @max-[30rem]/pane:grid @max-[30rem]/pane:h-auto @max-[30rem]/pane:grid-cols-[1rem_minmax(0,1fr)] @max-[30rem]/pane:items-start @max-[30rem]/pane:gap-x-[11px] @max-[30rem]/pane:gap-y-[5px] @max-[30rem]/pane:rounded-none @max-[30rem]/pane:px-[13px] @max-[30rem]/pane:py-[11px] {selected
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
    class="flex w-4 shrink-0 items-center justify-center @max-[30rem]/pane:col-start-1 @max-[30rem]/pane:row-start-1 @max-[30rem]/pane:pt-0.5 {GLYPH_COLOR[item.glyph]}"
    aria-hidden="true"
  >
    {#if item.glyph === "diagram"}
      <ArchitectureIcon size={14} />
    {:else if item.glyph === "artifact"}
      <ArtifactIcon size={14} />
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
  <span
    class="min-w-0 flex-[3] truncate text-workspace-chrome font-normal @max-[30rem]/pane:col-start-2 @max-[30rem]/pane:row-start-1 @max-[30rem]/pane:overflow-visible @max-[30rem]/pane:text-sm/[1.35] @max-[30rem]/pane:text-clip @max-[30rem]/pane:font-medium @max-[30rem]/pane:whitespace-normal @max-[30rem]/pane:text-pretty"
  >
    {#each titleRuns as run, i (i)}{#if run.hit}<mark
          class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit"
          >{run.text}</mark
        >{:else}{run.text}{/if}{/each}
  </span>

  <!-- Line 2, and only where the pointer's peek is not coming: two lines of the
       body so a row can be recognised without opening it. Dropped on a pinned
       row, where the title is already why it was pinned. -->
  {#if item.snippet && !item.pinned}
    <span
      class="hidden text-muted-foreground @max-[30rem]/pane:col-start-2 @max-[30rem]/pane:line-clamp-2 @max-[30rem]/pane:leading-[1.5] @max-[30rem]/pane:text-pretty"
    >
      {item.snippet}
    </span>
  {/if}

  <!-- Where it came from: the session that generated the artifact. It reads as
       a field like every other — full colour, no chip — and only becomes two
       targets under the pointer, where "Open" and "Open in split" replace the
       chat glyph. It grows with the row instead of sitting at a fixed measure,
       because a session name is the one column here with prose in it — every
       other column holds a number or a single word. The cap keeps it from
       running away on an ultrawide window, where the name has long since fit. -->
  <span
    class="flex min-w-0 max-w-[26rem] flex-[2] items-center gap-[5px] @max-[30rem]/pane:hidden"
  >
    {#if item.sessionId}
      <ChatCircleIcon size={14} class="shrink-0 opacity-70" />
      <span class="min-w-0 flex-1 truncate" title={sessionLabel ?? undefined}>
        {sessionLabel ?? "Session"}
      </span>
      <!-- The two ways back in. The slot is reserved at rest, so the name has
           the same measure whether or not the pointer is here. -->
      <span
        class="flex w-11 shrink-0 justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
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
  <!-- Dropped on the record: the relative age at the end of line 3 is already
       the row's time, and two dates on one line read as a disagreement. -->
  <span
    class="w-[4.5rem] shrink-0 text-right @max-[30rem]/pane:hidden"
    title={generated ? `Generated ${formatGeneratedFull(item.createdAt)}` : ""}
  >
    {generated}
  </span>

  <!-- Pin keeps the row's inner action slot: it is the row's own state, it is
       the frequent one, and it is harmless. On a pinned row it stays visible
       and turns primary; it is not filled in. Delete is not here — it sits at
       the far edge of the row, past status and time. -->
  <span class="flex shrink-0 @max-[30rem]/pane:hidden">
    <button
      type="button"
      class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-[background-color,color,opacity] duration-150 hover:bg-[var(--wash-3)] focus-visible:opacity-100 {item.pinned
 ? 'text-[color-mix(in_oklch,var(--primary)_78%,var(--foreground))] opacity-100'
 : 'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'} {selected
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

  <!-- The four trailing fields are four columns on a wide pane and one meta
       line on a record, so the wrapper is `display: contents` above the rung —
       the fields stay direct flex children of the row and keep their column
       measures — and becomes the line itself below it. Rendering them twice
       would be four formats kept in step by hand. -->
  <span
    class="contents @max-[30rem]/pane:col-start-2 @max-[30rem]/pane:flex @max-[30rem]/pane:items-center @max-[30rem]/pane:gap-2"
  >
    <!-- Where it lives. The ledger spans every project, so a wide pane names
         it whenever more than one project is present; on the record it is
         always stated, because the record is the only line that carries
         provenance at all. -->
    <span
      class="w-[4rem] shrink-0 truncate text-right @max-[30rem]/pane:w-auto @max-[30rem]/pane:text-left @max-[30rem]/pane:font-mono @max-[30rem]/pane:opacity-75 {showProject
 ? ''
 : 'hidden @max-[30rem]/pane:block'}"
      title={item.cwd}
    >
      {item.projectLabel}
    </span>
    <!-- Home is an icon-only column, like upstream: a fixed slot, so a row
         that lives in Solus Cloud keeps the same column measures as one that
         does not. -->
    <span class="flex w-4 shrink-0 items-center justify-center text-(--solus-text-tertiary) @max-[30rem]/pane:w-auto">
      {#if homeLabel}
        <span class="flex" role="img" aria-label={homeLabel} title={homeLabel} data-testid="workspace-row-home">
          <CloudIcon size={14} />
        </span>
      {/if}
    </span>

    {#if present.length > 0}
      <PresenceStack people={present} size={14} max={2} detail={(person) => (person.isEditing ? "editing…" : null)} class="shrink-0" />
    {/if}

    <!-- Upstream is a logo-only column. Its fixed slot keeps the status and time
         columns aligned for local works without adding placeholder
         prose to rows that have no external twin. The record has no columns to
         align, so the slot collapses to the logo it holds. -->
    <span
      class="flex w-4 shrink-0 items-center justify-center @max-[30rem]/pane:w-auto"
    >
      {#if upstreamProvider}
        <DocProviderLogo provider={upstreamProvider} size={13} />
      {/if}
    </span>

    <!-- Reviewers: who reviews a work, badged with the verdict they gave. Hover
         names who decided what, and when. A fixed slot, so rows without
         reviewers keep the status and time columns aligned. -->
    <span class="flex w-[3rem] shrink-0 items-center justify-end @max-[30rem]/pane:w-auto @max-[30rem]/pane:empty:hidden">
      <ReviewerAvatars reviewers={item.reviewers} size={14} />
    </span>

    <!-- Status is an icon in a fixed slot: a work's review state. Its word is
         the hover text and the screen-reader name. The one that needs the reader, a requested review, is amber.
         A verdict is not drawn here: it sits on the avatar of the reviewer who
         gave it, so the slot keeps only the word for screen readers. -->
    <span class="flex w-4 shrink-0 items-center justify-center @max-[30rem]/pane:w-auto @max-[30rem]/pane:empty:hidden">
      {#if status?.kind === "approved" || status?.kind === "changes_requested"}
        <span class="sr-only" data-testid="workspace-row-status" data-status={status.kind}>{status.label}</span>
      {:else if status}
        <span class="flex" role="img" aria-label={status.label} title={status.label} data-testid="workspace-row-status" data-status={status.kind}>
          {#if status.kind === "review_requested"}
            <EyeIcon size={14} class={PR_CHECKS_TONE.pending} />
          {:else}
            <ClockIcon size={14} class={PR_STATUS_TONE.draft} />
          {/if}
        </span>
      {/if}
    </span>

    <!-- The record's one piece of slack, so age lands on the right edge the way
         it does at the end of the wide row's column run. -->
    <span class="hidden @max-[30rem]/pane:block @max-[30rem]/pane:flex-1"></span>

    <span
      class="w-[2.75rem] shrink-0 text-right tabular-nums @max-[30rem]/pane:w-auto @max-[30rem]/pane:font-mono @max-[30rem]/pane:opacity-70"
      title="Last activity {formatGeneratedFull(item.timestamp)}"
    >
      {formatLedgerTime(item.timestamp)}
    </span>
  </span>

  <!-- Delete lives past every column, at the row's outer edge — roughly 130px
       of status and time separate it from the pin, so the two can no longer be
       confused for one another under a moving cursor. The slot is reserved at
       rest rather than inserted on hover, so no column shifts when the trash
       appears. -->
  <span class="flex w-[22px] shrink-0 justify-end @max-[30rem]/pane:hidden">
    {#if onDelete}
      <button
        type="button"
        class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-0 transition-[background-color,color,opacity] duration-150 group-focus-within:opacity-100 group-hover:opacity-60 hover:bg-[color-mix(in_oklch,var(--failure)_10%,transparent)] hover:text-[var(--failure)] hover:opacity-100! focus-visible:opacity-100 pointer-coarse:opacity-60 {selected
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
