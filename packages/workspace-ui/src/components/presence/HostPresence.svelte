<script lang="ts">
  import { Users as UsersIcon } from "@lucide/svelte";
  import { getSessionSidebarStore, getWorkspaceContext, serversStore } from "../../contexts";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as Sidebar from "../ui/sidebar";
  import PresenceAvatar from "./PresenceAvatar.svelte";
  import { stackPeople } from "./lib/presence-people";
  import { canJumpTo, primaryPresence, rosterWhere, type HostPerson, type RosterNames, type RosterPerson } from "./lib/host-people";

  /**
   * Everyone connected to the hosts this client is on, as one more row of the
   * sidebar's navigation: the same rung, icon slot, and label as the pages above
   * it, with the faces trailing where a page keeps its shortcut. A click opens
   * the roster; a person's row offers a jump to what they have open, or a
   * follow that keeps going where they go — per host, when they are on several.
   * Absent when nobody else is anywhere, which is the ordinary single-person state.
   */
  const session = getWorkspaceContext();
  const sidebar = getSessionSidebarStore();

  const people = $derived(presenceStore.roster());
  const stacked = $derived(stackPeople(people, 3));
  const summary = $derived(
    people.length === 1 ? `${people[0].displayName} is here` : `${people.length} people are here`,
  );
  const spansHosts = $derived(new Set(people.flatMap((person) => person.presences.map((presence) => presence.serverId))).size > 1);
  const following = $derived(presenceStore.following);
  const hostLabel = (serverId: string) => serversStore.hostFor(serverId)?.label;

  const names: RosterNames = {
    get mountedSessions() { return Object.values(session.sessions); },
    get sidebarSessions() { return sidebar.catalogTasks.flatMap((task) => sidebar.sessionsFor(task)); },
    workTitle: (workId) => session.worksStore.get(workId)?.title,
  };

  function isFollowed(person: RosterPerson): boolean {
    return person.presences.some((presence) => presenceStore.isFollowing(presence.serverId, presence.userId));
  }

  function jumpTo(presence: HostPerson): void {
    const focus = presence.focus;
    if (!focus || focus.kind === "none") return;
    if (focus.kind === "session") {
      session.openRoute({ name: "chat", params: { sessionId: focus.sessionId, serverId: presence.serverId } }, { via: "click" });
    } else {
      session.openRoute({ name: "work", params: { workId: focus.workId, serverId: presence.serverId } }, { via: "click" });
    }
  }

  function toggleFollow(presence: HostPerson): void {
    if (presenceStore.isFollowing(presence.serverId, presence.userId)) presenceStore.stopFollowing();
    else presenceStore.follow({ serverId: presence.serverId, userId: presence.userId, displayName: presence.displayName });
  }
</script>

{#if people.length > 0}
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
            title={following ? `Following ${following.displayName}` : summary}
            aria-label={summary}
            data-testid="host-presence"
            data-count={people.length}
          >
            <span class="flex shrink-0 items-center"><UsersIcon size={14} /></span>
            <span class="min-w-0 flex-1 truncate text-left text-workspace-chrome">
              {following ? `Following ${following.displayName}` : summary}
            </span>
            <!-- A shallow overlap keeps initials readable; opaque fills and
                 sidebar-coloured rings separate the faces. -->
            <span class="inline-flex shrink-0 items-center px-0.5 py-0.5" style="--presence-avatar-surface:var(--sidebar)">
              {#each stacked.shown as person, index (person.userId)}
                <PresenceAvatar
                  {person}
                  size={16}
                  composing={person.isComposing}
                  ringed={isFollowed(person)}
                  class="ring-1 ring-sidebar {index > 0 ? '-ml-0.5' : ''}"
                />
              {/each}
              {#if stacked.overflow > 0}
                <span
                  class="relative -ml-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_10%,var(--sidebar))] px-0.5 text-[7px] font-medium text-(--solus-text-secondary) ring-1 ring-sidebar"
                  aria-hidden="true">+{stacked.overflow}</span
                >
              {/if}
            </span>
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="start" sideOffset={4} class="w-[min(18rem,calc(100vw-2rem))]">
        <DropdownMenu.Label>Here now</DropdownMenu.Label>
        {#each people as person (person.userId)}
          {@const several = person.presences.length > 1}
          <DropdownMenu.Sub>
            <!-- Two lines need room: the row grows past the menu rung instead of
                 painting its second line into the neighbour. -->
            <DropdownMenu.SubTrigger class="h-auto min-h-10 gap-2.5 py-1.5 pointer-coarse:min-h-12" data-testid="host-presence-person" data-user={person.userId}>
              <PresenceAvatar {person} size={20} composing={person.isComposing} ringed={isFollowed(person)} />
              <span class="flex min-w-0 flex-1 flex-col gap-px leading-tight">
                <span class="truncate text-(--solus-text-primary)">{person.displayName}</span>
                <span class="truncate text-[0.875em] text-(--solus-text-tertiary)">
                  {isFollowed(person) ? "Following" : rosterWhere(person, names, spansHosts, hostLabel)}
                </span>
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent class="min-w-44">
              {#each person.presences as presence (presence.serverId)}
                {@const host = several ? hostLabel(presence.serverId) : undefined}
                {@const followed = presenceStore.isFollowing(presence.serverId, presence.userId)}
                <DropdownMenu.Item disabled={!canJumpTo(presence)} onSelect={() => jumpTo(presence)}>
                  {host ? `Jump to · ${host}` : "Jump to"}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => toggleFollow(presence)}>
                  {followed ? "Stop following" : host ? `Follow on ${host}` : "Follow"}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
{/if}
