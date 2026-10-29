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
    Users as SharedIcon,
    Lock as PrivateIcon,
    Link2 as LinkIcon,
    Building2 as OrganizationIcon,
  } from "@lucide/svelte";
  import DocProviderLogo from "../work/DocProviderLogo.svelte";
  import ReviewerAvatars from "../work/ReviewerAvatars.svelte";
  import { PR_CHECKS_TONE, PR_STATUS_TONE } from "../prs/lib/pr-row-styles";
  import type { WorkspaceItem } from "./lib/workspace-items";
  import {
    formatGeneratedFull,
    formatLedgerTime,
    isSharedWithMe,
    roleLabel,
    rowStatus,
    shareStateLabel,
    upstreamProviderFor,
  } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";
  import PresenceStack from "../presence/PresenceStack.svelte";
  import type { PresencePerson } from "../presence/lib/presence-people";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { formatComboText } from "../../lib/keybindings/match";

  /**
   * One work as a card: its kind, its title, the session it came from, and at
   * the foot who is in it and when it last moved. The same facts the ledger row
   * carried, stacked instead of columned, so three fit across a wide pane and
   * one fills a stacked one.
   */
  interface Props {
    item: WorkspaceItem;
    selected: boolean;
    showProject: boolean;
    homeLabel?: string | null;
    query: string;
    sessionLabel: string | null;
    /** Who shared it, when the work is another person's; null when unknown. */
    sharedBy?: string | null;
    onOpen: () => void;
    onTogglePin: () => void;
    onDelete?: () => void;
    onOpenSession?: () => void;
    onOpenSessionSplit?: () => void;
    onPeek?: (card: HTMLElement) => void;
    onPeekLeave?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
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
    sharedBy = null,
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
  const upstreamProvider = $derived(upstreamProviderFor(item));
  const shared = $derived(isSharedWithMe(item.role));
  /** Who else may open the reader's own work; null when its host did not say. */
  const shareState = $derived(shared ? null : shareStateLabel(item.share));

  const KIND_LABEL = { doc: "Doc", slides: "Slides", diagram: "Diagram", artifact: "Artifact" } as const;
  // Works take two Solus hues that carry no lifecycle meaning: teal for written
  // artifacts, purple for drawn ones, as a session card's chips draw them. Amber
  // and sage are spoken for elsewhere — they read as "needs you" and "done" on
  // every other surface, so a document must not wear them.
  const GLYPH_COLOR = {
    doc: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    slides: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    diagram: "text-[color-mix(in_oklab,var(--solus-art-6)_66%,var(--foreground))]",
    artifact: "text-[color-mix(in_oklab,var(--solus-art-6)_66%,var(--foreground))]",
  } as const;
</script>

<!-- A soft card: a hairline edge and a faint drop at rest, a deeper shadow
     under the pointer, and the 45% primary ring a focused field takes when
     selected. Shadow only — no transform — so a hover never moves the grid. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="group relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl bg-card px-4 pt-3.5 pb-3 text-xs transition-shadow duration-200 select-none focus-visible:outline-none {selected
    ? 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--primary)_40%,transparent)]'
    : 'shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_20%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--foreground)_22%,transparent)]'}"
  data-selected={selected ? "true" : null}
  data-testid="workspace-card"
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
  <!-- Line 1: what kind of thing it is, and the card's own two actions at the
       far edge. Pin stays visible once set; delete only ever under the pointer. -->
  <span class="flex h-4 min-w-0 items-center gap-1.5 text-muted-foreground">
    <span class="flex shrink-0 items-center {GLYPH_COLOR[item.glyph]}" aria-hidden="true">
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
    <span class="truncate">{KIND_LABEL[item.glyph]}</span>
    {#if upstreamProvider}
      <DocProviderLogo provider={upstreamProvider} size={13} />
    {/if}
    {#if homeLabel}
      <span class="flex text-(--solus-text-tertiary)" role="img" aria-label={homeLabel} title={homeLabel} data-testid="workspace-row-home">
        <CloudIcon size={14} />
      </span>
    {/if}
    <span class="flex-1"></span>
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
    {#if !shared}
      <button
        type="button"
        class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-[background-color,color,opacity] duration-150 hover:bg-[var(--wash-3)] focus-visible:opacity-100 {item.pinned
          ? 'text-[color-mix(in_oklch,var(--primary)_78%,var(--foreground))] opacity-100'
          : 'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'} {selected ? 'opacity-100' : ''}"
        onclick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
        aria-label={item.pinned ? "Unpin" : "Pin"}
        title={`${item.pinned ? "Unpin" : "Pin"} (${comboHint("workspace.toggle-pin")})`}
      >
        <PushPinIcon size={14} />
      </button>
    {/if}
    {#if onDelete}
      <button
        type="button"
        class="flex size-[22px] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-0 transition-[background-color,color,opacity] duration-150 group-focus-within:opacity-100 group-hover:opacity-60 hover:bg-[color-mix(in_oklch,var(--failure)_10%,transparent)] hover:text-[var(--failure)] hover:opacity-100! focus-visible:opacity-100 pointer-coarse:opacity-60 {selected ? 'opacity-60' : ''}"
        onclick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label="Delete document"
        title={`Delete (${formatComboText({ alt: true, code: "Backspace" })})`}
      >
        <TrashIcon size={14} />
      </button>
    {/if}
  </span>

  <span class="line-clamp-2 text-workspace-chrome leading-[1.35] font-medium tracking-[-0.006em] text-foreground text-pretty">
    {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
  </span>

  <!-- Where it came from: the session that generated it, with the two ways
       back in under the pointer. A hand-made work keeps the line's height so
       the feet of a row of cards align. -->
  <span class="flex h-[18px] min-w-0 items-center gap-[5px] text-muted-foreground">
    {#if item.sessionId}
      <ChatCircleIcon size={13} class="shrink-0 opacity-70" />
      <span class="min-w-0 flex-1 truncate" title={sessionLabel ?? undefined}>{sessionLabel ?? "Session"}</span>
      <span class="flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
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
    {:else if showProject}
      <span class="min-w-0 flex-1 truncate" title={item.cwd}>{item.projectLabel}</span>
    {/if}
  </span>

  <!-- The foot: who, then when. A shared work names the person it came from
       and how far the reader may go; the reader's own says who else may open
       it, so what they have let out is visible at a glance. -->
  <span class="flex min-h-[18px] min-w-0 items-center gap-1.5 text-muted-foreground">
    {#if shared && item.role}
      <SharedIcon size={13} class="shrink-0 opacity-70" />
      <span class="min-w-0 truncate" data-testid="workspace-card-role">{sharedBy ? `${sharedBy} · ` : ""}{roleLabel(item.role)}</span>
    {:else if shareState}
      {#if shareState.glyph === "link"}
        <LinkIcon size={13} class="shrink-0 opacity-70" />
      {:else if shareState.glyph === "organization"}
        <OrganizationIcon size={13} class="shrink-0 opacity-70" />
      {:else if shareState.glyph === "people"}
        <SharedIcon size={13} class="shrink-0 opacity-70" />
      {:else}
        <PrivateIcon size={13} class="shrink-0 opacity-70" />
      {/if}
      <span class="min-w-0 truncate" data-testid="workspace-card-share" data-share={shareState.glyph}>{shareState.label}</span>
    {:else if showProject && item.sessionId}
      <span class="min-w-0 truncate" title={item.cwd}>{item.projectLabel}</span>
    {/if}
    {#if present.length > 0}
      <PresenceStack people={present} size={14} max={2} detail={(person) => (person.isEditing ? "editing…" : null)} class="shrink-0" />
    {/if}
    <ReviewerAvatars reviewers={item.reviewers} size={14} />
    <span class="flex-1"></span>
    <span class="shrink-0 tabular-nums" title="Last activity {formatGeneratedFull(item.timestamp)}">{formatLedgerTime(item.timestamp)}</span>
  </span>
</div>
