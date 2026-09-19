<script lang="ts">
  import {
    FileText as FileTextIcon,
    MessageSquare as MessageSquareIcon,
    SquareCheck as SquareCheckIcon,
    SquareTerminal as TerminalWindowIcon,
  } from "@lucide/svelte";
  import type { ShareResource, ShareRole } from "@solus/contracts/sharing";
  import type { TaskSessionLink } from "@solus/contracts/task-types";
  import { presenceStore } from "@solus/workspace-ui/contexts/presence/presence.store.svelte";
  import PresenceAvatar from "@solus/workspace-ui/components/presence/PresenceAvatar.svelte";
  import { guestAccessLine, guestSessionRows } from "./lib/guest-rail";

  /**
   * What you're in (docs/plans/multiplayer-sharing.md §4.2): the resource the
   * link opened, the standing the guest holds on it, who else is in the session
   * on screen, and — under a shared task — its sessions, each a way in. Every
   * fact is one the host already sent; the rail asks for nothing host-wide.
   */
  interface Props {
    serverId: string;
    resource: ShareResource;
    resourceTitle: string;
    role: ShareRole;
    /** The session on screen, whose room the rail lists. */
    screenSessionId: string | null;
    /** The shared task's sessions; empty for a session or document link. */
    sessions: readonly TaskSessionLink[];
    /** A live title for a session the guest has open, else null. */
    liveTitleFor: (sessionId: string) => string | null;
    onOpenSession: (sessionId: string) => void;
    onOpenResource: () => void;
    /** True while the task page itself is on screen. */
    resourceOnScreen: boolean;
  }
  let { serverId, resource, resourceTitle, role, screenSessionId, sessions, liveTitleFor, onOpenSession, onOpenResource, resourceOnScreen }: Props = $props();

  const accessLine = $derived(guestAccessLine(resource.kind, role));
  const rows = $derived(guestSessionRows(sessions, screenSessionId, liveTitleFor));
  const people = $derived(screenSessionId ? presenceStore.sessionPeople(serverId, screenSessionId) : []);
  const room = $derived(screenSessionId ? presenceStore.sessionRoom(serverId, screenSessionId) : undefined);
  const activeUserId = $derived(room?.activeTurn?.authorUserId ?? null);
</script>

<aside class="flex h-full w-[16.5rem] shrink-0 flex-col gap-5 overflow-y-auto border-l border-(--hairline) bg-(--solus-rail-bg) px-3 py-4" aria-label="What you're in" data-testid="guest-rail">
  <section class="flex flex-col gap-2">
    <h2 class="px-1.5 text-[0.8125em] font-medium tracking-[0.06em] text-muted-foreground uppercase">Shared with you</h2>
    <!-- The resource is a row like the sessions under it; on a task it is the
         way back to the page, so it is a control there. -->
    {#if resource.kind === "task"}
      <button
        type="button"
        class="flex min-h-9 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-left transition-[background] duration-150 hover:bg-(--solus-surface-hover) pointer-coarse:min-h-11 {resourceOnScreen ? 'bg-(--solus-surface-hover) font-medium' : ''}"
        aria-current={resourceOnScreen ? "page" : undefined}
        data-testid="guest-rail-resource"
        onclick={onOpenResource}
      >
        <SquareCheckIcon size={14} class="shrink-0 text-muted-foreground" />
        <span class="truncate text-(--solus-text-primary)">{resourceTitle}</span>
      </button>
    {:else}
      <div class="flex min-h-9 items-center gap-2 overflow-hidden px-2 font-medium" data-testid="guest-rail-resource">
        {#if resource.kind === "work"}
          <FileTextIcon size={14} class="shrink-0 text-muted-foreground" />
        {:else}
          <MessageSquareIcon size={14} class="shrink-0 text-muted-foreground" />
        {/if}
        <span class="truncate text-(--solus-text-primary)">{resourceTitle}</span>
      </div>
    {/if}
    <p class="px-2 leading-relaxed text-(--solus-text-tertiary)" data-testid="guest-rail-access">{accessLine}</p>
  </section>

  {#if resource.kind === "task"}
    <section class="flex flex-col gap-1">
      <h2 class="flex items-center gap-1.5 px-1.5 pb-1 text-[0.8125em] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        Sessions
        <span class="tabular-nums opacity-60">{rows.length}</span>
      </h2>
      {#if rows.length === 0}
        <p class="px-2 leading-relaxed text-(--solus-text-tertiary)">No session has worked on this task yet.</p>
      {:else}
        {#each rows as row (row.sessionId)}
          <button
            type="button"
            class="flex min-h-10 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1 text-left transition-[background] duration-150 hover:bg-(--solus-surface-hover) pointer-coarse:min-h-12 {row.isOpen ? 'bg-(--solus-surface-hover)' : ''}"
            aria-current={row.isOpen ? "page" : undefined}
            data-testid="guest-rail-session"
            onclick={() => onOpenSession(row.sessionId)}
          >
            <TerminalWindowIcon size={13} class="shrink-0 text-muted-foreground opacity-70" />
            <span class="flex min-w-0 flex-1 flex-col gap-px leading-tight">
              <span class="truncate text-(--solus-text-primary) {row.isOpen ? 'font-medium' : ''}">{row.title}</span>
              <span class="truncate font-mono text-[0.8125em] text-(--solus-text-tertiary)">{row.meta}</span>
            </span>
          </button>
        {/each}
      {/if}
    </section>
  {/if}

  {#if screenSessionId}
    <section class="flex flex-col gap-1">
      <h2 class="px-1.5 pb-1 text-[0.8125em] font-medium tracking-[0.06em] text-muted-foreground uppercase">Here now</h2>
      {#if people.length === 0}
        <p class="px-2 leading-relaxed text-(--solus-text-tertiary)">Only you, for the moment.</p>
      {:else}
        {#each people as person (person.userId)}
          <div class="flex min-h-8 items-center gap-2 px-2" data-testid="guest-rail-person">
            <PresenceAvatar {person} size={18} ringed={person.userId === activeUserId} composing={person.isComposing} />
            <span class="truncate text-(--solus-text-primary)">{person.displayName}</span>
            {#if person.userId === activeUserId}
              <span class="ml-auto shrink-0 text-[0.875em] text-(--solus-text-tertiary)">running a turn</span>
            {:else if person.isComposing}
              <span class="ml-auto shrink-0 text-[0.875em] text-(--solus-text-tertiary)">typing…</span>
            {/if}
          </div>
        {/each}
      {/if}
    </section>
  {/if}
</aside>
