<script lang="ts">
  import { GitBranch as BranchIcon, WifiOff as OfflineIcon } from "@lucide/svelte";
  import type { User } from "@solus/contracts/user";
  import SessionStatusGlyph from "../session/SessionStatusGlyph.svelte";
  import UserAvatar from "../users/UserAvatar.svelte";
  import PresenceStack from "../presence/PresenceStack.svelte";
  import type { PresencePerson } from "../presence/lib/presence-people";
  import type { WorkspaceSessionItem } from "./lib/workspace-items";
  import { formatGeneratedFull, formatLedgerTime, roleLabel } from "./lib/workspace-items";
  import { highlightRuns } from "../../lib/searchHighlight";

  /**
   * One session another person shared with the reader, as a card: whether its
   * agent works now and on which machine, the reader's role, the title, the
   * project and branch, then who owns it and who is in it.
   *
   * The status glyphs are the sidebar's own, so a session reads the same here
   * as in the list the reader already knows.
   */
  interface Props {
    item: WorkspaceSessionItem;
    selected: boolean;
    query: string;
    /** The machine that runs it, as this client names it. */
    hostLabel: string | null;
    /** The owner, when the organization's directory names them. */
    owner: User | null;
    present?: PresencePerson[];
    onOpen: () => void;
    onContextMenu?: (event: MouseEvent) => void;
  }
  let { item, selected, query, hostLabel, owner, present = [], onOpen, onContextMenu }: Props = $props();

  const titleRuns = $derived(highlightRuns(item.title, query));
  const attention = $derived(item.status === "running" ? "running" : item.status === "interrupted" ? "error" : null);
  const statusLabel = $derived(item.runnerOffline ? "Host offline" : item.status === "running" ? "Running" : item.status === "interrupted" ? "Interrupted" : "Idle");
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="group relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl bg-card px-4 pt-3.5 pb-3 text-xs transition-shadow duration-200 select-none focus-visible:outline-none {selected
    ? 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--primary)_40%,transparent)]'
    : 'shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_20%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--foreground)_22%,transparent)]'} {item.runnerOffline ? 'opacity-65' : ''}"
  data-selected={selected ? "true" : null}
  data-testid="workspace-session-card"
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onOpen}
  oncontextmenu={onContextMenu}
>
  <span class="flex h-4 min-w-0 items-center gap-1.5 text-muted-foreground">
    {#if item.runnerOffline}
      <OfflineIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
    {:else}
      <SessionStatusGlyph {attention} />
    {/if}
    <span class="shrink-0" data-testid="workspace-session-status">{statusLabel}</span>
    {#if hostLabel}
      <span class="min-w-0 truncate opacity-80">· {hostLabel}</span>
    {/if}
    <span class="flex-1"></span>
    <span class="shrink-0" data-testid="workspace-card-role">{roleLabel(item.role)}</span>
  </span>

  <span class="line-clamp-2 text-workspace-chrome leading-[1.35] font-medium tracking-[-0.006em] text-foreground text-pretty">
    {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
  </span>

  <span class="flex h-[18px] min-w-0 items-center gap-[5px] text-muted-foreground">
    {#if item.runnerOffline}
      <span class="truncate">Read only from the mirror</span>
    {:else}
      <span class="min-w-0 truncate">{item.projectLabel}</span>
      {#if item.branch}
        <BranchIcon size={12} class="shrink-0 opacity-70" aria-hidden="true" />
        <span class="min-w-0 truncate font-mono">{item.branch}</span>
      {/if}
    {/if}
  </span>

  <span class="flex min-h-[18px] min-w-0 items-center gap-1.5 text-muted-foreground">
    {#if owner}
      <UserAvatar user={owner} size={14} />
      <span class="min-w-0 truncate">{owner.displayName}</span>
    {:else}
      <span class="min-w-0 truncate">Shared with you</span>
    {/if}
    {#if present.length > 0}
      <PresenceStack people={present} size={14} max={2} detail={(person) => (person.isComposing ? "typing…" : null)} class="shrink-0" />
    {/if}
    <span class="flex-1"></span>
    <span class="shrink-0 tabular-nums" title="Last activity {formatGeneratedFull(item.timestamp)}">{formatLedgerTime(item.timestamp)}</span>
  </span>
</div>
