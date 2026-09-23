<script lang="ts">
  import { getSessionRecords, getWorkspaceContext, getSessionSidebarStore, presenceStore, serversStore } from "@solus/workspace-ui/contexts";
  import PresenceAvatar from "@solus/workspace-ui/components/presence/PresenceAvatar.svelte";
  import {
    canJumpTo,
    primaryPresence,
    rosterWhere,
    type RosterNames,
    type RosterPerson,
  } from "@solus/workspace-ui/components/presence/lib/host-people";
  import { SHEET_ROW_META, SHEET_SECTION_LABEL } from "./lib/sheet-styles";

  /**
   * The phone's roster: the sidebar's "here now" row as drawer rows, one per
   * person however many hosts they are on. A tap on a person goes where they
   * are; the trailing control follows or stops following them there. Absent
   * when nobody else is anywhere.
   */
  interface Props {
    /** Close the drawer after a navigation. */
    onNavigate: () => void;
  }
  let { onNavigate }: Props = $props();

  const session = getWorkspaceContext();
  const sessions = getSessionRecords();
  const sidebar = getSessionSidebarStore();

  const people = $derived(presenceStore.roster());
  const spansHosts = $derived(new Set(people.flatMap((person) => person.presences.map((presence) => presence.serverId))).size > 1);
  const hostLabel = (serverId: string) => serversStore.hostFor(serverId)?.label;

  const names: RosterNames = {
    get mountedSessions() { return Object.values(sessions.byId); },
    get sidebarSessions() { return sidebar.catalogTasks.flatMap((task) => sidebar.sessionsFor(task)); },
  };

  function isFollowed(person: RosterPerson): boolean {
    return person.presences.some((presence) => presenceStore.isFollowing(presence.serverId, presence.userId));
  }

  function jumpTo(person: RosterPerson): void {
    const presence = primaryPresence(person);
    const focus = presence.focus;
    if (!focus || focus.kind === "none") return;
    if (focus.kind === "session") {
      session.openRoute({ name: "chat", params: { sessionId: focus.sessionId, serverId: presence.serverId } }, { via: "click" });

    }
    onNavigate();
  }

  function toggleFollow(person: RosterPerson): void {
    if (isFollowed(person)) {
      presenceStore.stopFollowing();
      return;
    }
    const presence = primaryPresence(person);
    presenceStore.follow({ serverId: presence.serverId, userId: presence.userId, displayName: presence.displayName });
    onNavigate();
  }
</script>

{#if people.length > 0}
  <div class="{SHEET_SECTION_LABEL} px-2 pt-3.5 pb-1.5">Here now</div>
  {#each people as person (person.userId)}
    {@const followed = isFollowed(person)}
    {@const jumpable = canJumpTo(primaryPresence(person))}
    <!-- Two controls side by side, never nested: the person is the jump, the
         pill is the follow. A person with nothing open is a row, not a button. -->
    <div class="flex h-[3.875rem] items-center gap-2 pr-3" data-testid="mobile-here-now-person" data-user={person.userId}>
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-[0.6875rem] rounded-2xl border-0 bg-transparent px-3 text-left [-webkit-tap-highlight-color:transparent] {jumpable
          ? 'cursor-pointer active:bg-(--wash-1)'
          : 'cursor-default'}"
        disabled={!jumpable}
        aria-label={jumpable ? `Jump to ${person.displayName}` : person.displayName}
        onclick={() => jumpTo(person)}
      >
        <PresenceAvatar {person} size={24} composing={person.isComposing} ringed={followed} />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate font-medium text-(--solus-text-primary)">{person.displayName}</span>
          <span class="mt-[0.1875rem] truncate {SHEET_ROW_META}">{followed ? "Following" : rosterWhere(person, names, spansHosts, hostLabel)}</span>
        </span>
      </button>
      <button
        type="button"
        class="flex h-9 shrink-0 cursor-pointer items-center rounded-full border-0 px-3 text-xs font-semibold transition-transform duration-[120ms] active:scale-[0.96] [-webkit-tap-highlight-color:transparent] {followed
          ? 'bg-(--primary) text-(--primary-foreground)'
          : 'bg-(--wash-3) text-(--solus-text-secondary)'}"
        aria-pressed={followed}
        onclick={() => toggleFollow(person)}
      >
        {followed ? "Following" : "Follow"}
      </button>
    </div>
  {/each}
{/if}
