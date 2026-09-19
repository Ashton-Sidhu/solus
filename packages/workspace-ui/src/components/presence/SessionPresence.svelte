<script lang="ts">
  import { Users as UsersIcon } from "@lucide/svelte";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import { sharesStore } from "../../contexts/sharing/shares.store.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PresenceAvatar from "./PresenceAvatar.svelte";
  import PresenceStack from "./PresenceStack.svelte";
  import type { PresencePerson } from "./lib/presence-people";

  /**
   * Who else is in this session, for the band above the transcript: the faces
   * of everyone watching, a dot on whoever is typing, a ring on whoever's turn
   * is running. Empty, and absent, when the reader is alone.
   *
   * The faces are a control, not a decoration: a click (or a tap, or Enter)
   * opens the roster, so it is reachable without a hover. Everyone listed is
   * already here, so the one thing to do with a person is follow them; the way
   * to let someone in or out is the scope, which the last row opens.
   */
  interface Props {
    serverId: string | null | undefined;
    sessionId: string | null | undefined;
    /** The session's name, for the share dialog the roster opens. */
    title: string;
    size?: 16 | 18 | 20;
    class?: string;
  }
  let { serverId, sessionId, title, size = 18, class: className = "" }: Props = $props();

  $effect(() => {
    if (serverId) void presenceStore.ensure(serverId);
  });

  const people = $derived(serverId && sessionId ? presenceStore.sessionPeople(serverId, sessionId) : []);
  const room = $derived(serverId && sessionId ? presenceStore.sessionRoom(serverId, sessionId) : undefined);
  const activeUserId = $derived(room?.activeTurn?.authorUserId ?? null);
  const summary = $derived(people.length === 1 ? `${people[0].displayName} is here` : `${people.length} people are here`);

  function detail(person: PresencePerson): string | null {
    if (person.userId === activeUserId) return "running a turn";
    if (person.isComposing) return "typing…";
    return person.deviceCount > 1 ? `${person.deviceCount} devices` : null;
  }

  function isFollowed(person: PresencePerson): boolean {
    return !!serverId && presenceStore.isFollowing(serverId, person.userId);
  }

  function toggleFollow(person: PresencePerson): void {
    if (!serverId) return;
    if (isFollowed(person)) presenceStore.stopFollowing();
    else presenceStore.follow({ serverId, userId: person.userId, displayName: person.displayName });
  }

  const canShare = $derived(!!serverId && !!sessionId && sharesStore.canShareFrom(serverId));

  function openScope(): void {
    if (!serverId || !sessionId) return;
    sharesStore.open({ serverId, resource: { kind: "session", id: sessionId }, title });
  }
</script>

{#if people.length > 0}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="inline-flex shrink-0 cursor-pointer items-center rounded-md border-0 bg-transparent p-0.5 transition-[background-color] duration-100 hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-ring {className}"
          title={summary}
          aria-label={summary}
          data-testid="session-presence"
        >
          <PresenceStack {people} {size} {activeUserId} tooltip={false} />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={4} class="w-[min(16rem,calc(100vw-2rem))]">
      <DropdownMenu.Label>In this session</DropdownMenu.Label>
      {#each people as person (person.userId)}
        {@const line = detail(person)}
        {@const followed = isFollowed(person)}
        <!-- The row is the follow toggle; its trailing word says which way. -->
        <DropdownMenu.Item class="h-auto min-h-9 gap-2.5 py-1.5 pointer-coarse:min-h-12" data-testid="session-presence-person" data-user={person.userId} onSelect={() => toggleFollow(person)}>
          <PresenceAvatar {person} size={20} ringed={person.userId === activeUserId || followed} composing={person.isComposing} />
          <span class="flex min-w-0 flex-1 flex-col gap-px leading-tight">
            <span class="truncate text-(--solus-text-primary)">{person.displayName}</span>
            {#if followed}
              <span class="truncate text-[0.875em] text-(--solus-text-tertiary)">Following</span>
            {:else if line}
              <span class="truncate text-[0.875em] text-(--solus-text-tertiary)">{line}</span>
            {/if}
          </span>
          <span class="shrink-0 text-[0.875em] text-(--solus-text-tertiary)">{followed ? "Stop following" : "Follow"}</span>
        </DropdownMenu.Item>
      {/each}
      {#if canShare}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={openScope}>
          <UsersIcon /><span class="flex-1">Who can open…</span>
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
