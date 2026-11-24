<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Plus as NewIcon } from "@lucide/svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { getClientShellContext, getWorkspaceContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import ProviderMark from "../../ui/ProviderMark.svelte";
  import { providerMark } from "../../insights/lib/provider";
  import AppSessionCard from "./AppSessionCard.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { appSessionRun, replyToAppSession, startAppSession } from "./lib/app-session-actions";
  import { adjacentAppSession, appSessionGroups, selectedAppSession } from "./lib/app-sessions";

  /**
   * The sessions linked to the app (docs/plans/apps.md §9.2): a plain list
   * grouped by how each session stands, and one card with the selected
   * session's last turn and a reply. New starts a session for the app in its
   * project, linked to it. `session.statusChanged` moves a row between the
   * groups as its run starts and ends.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  const shell = getClientShellContext();
  const workspace = getWorkspaceContext();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => appsStore.sessions.watch(hostId, appId));
  });
  const sessions = $derived(appsStore.sessions.get(serverId, app.id));

  let now = $state(Date.now());
  $effect(() =>
    messageTimestampClock.subscribe((value) => {
      now = value;
    }),
  );
  const groups = $derived(appSessionGroups(sessions ?? [], now));

  /** The row the person chose; the first row until they choose. */
  let chosenSessionId = $state<string | null>(null);
  /** The card starts a new session instead of showing one. */
  let isStartingNew = $state(false);
  const selected = $derived(selectedAppSession(groups, chosenSessionId));
  const selectedLink = $derived(sessions?.find((link) => link.sessionId === selected?.sessionId) ?? null);
  let list = $state<HTMLElement | null>(null);

  function select(sessionId: string) {
    chosenSessionId = sessionId;
    isStartingNew = false;
  }

  /** Up and Down move through the rows, as in the sidebar. */
  async function handleListKeydown(event: KeyboardEvent) {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    const next = adjacentAppSession(groups, selected?.sessionId ?? null, delta);
    if (!next) return;
    event.preventDefault();
    select(next);
    await tick();
    list?.querySelector<HTMLElement>(`[data-session-id="${next}"]`)?.focus();
  }

  function openSession(sessionId: string) {
    shell.openResource({ kind: "session", sessionId, serverId });
  }

  async function unlink(sessionId: string) {
    try {
      await appsStore.unlinkSession(serverId, app.id, sessionId);
      if (chosenSessionId === sessionId) chosenSessionId = null;
    } catch (error) {
      toasts.error("The session was not unlinked", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function send(prompt: string) {
    if (isStartingNew || !selected) {
      const run = appSessionRun(workspace.settings.activeAgent, (provider) => workspace.config.defaultModelConfigFor(provider));
      const sessionId = await startAppSession(serverId, app, prompt, run);
      chosenSessionId = sessionId;
      isStartingNew = false;
      return;
    }
    await replyToAppSession(serverId, selected.sessionId, prompt);
  }
</script>

{#if sessions === undefined}
  <ManageSectionState
    count={undefined}
    error={appsStore.sessions.errorFor(serverId, app.id)}
    empty=""
    onRetry={() => void appsStore.sessions.load(serverId, app.id)}
  >
    {#snippet children()}{/snippet}
  </ManageSectionState>
{:else}
  <div class="flex min-w-0 gap-5 @max-[48rem]/pane:flex-col" data-testid="app-sessions">
    <!-- The list: plain on the page, never in the card. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <nav
      bind:this={list}
      class="flex w-75 shrink-0 flex-col gap-0.5 pt-0.5 @max-[48rem]/pane:w-full"
      aria-label="Linked sessions"
      onkeydown={(event) => void handleListKeydown(event)}
    >
      <div class="flex items-center justify-between gap-3 px-2.5 pb-2.5">
        <h3 class="m-0 text-[15px] leading-4.5 font-semibold text-foreground">Linked sessions</h3>
        <Button
          size="sm"
          variant="outline"
          class="h-7.5 rounded-full px-3 text-[13px]"
          aria-pressed={isStartingNew}
          onclick={() => (isStartingNew = true)}
          data-testid="app-session-new"
        >
          <NewIcon /> New
        </Button>
      </div>

      {#if groups.length === 0}
        <p class="m-0 px-2.5 py-2 text-[13px] text-(--solus-text-secondary)">No session is linked to this app yet. A session that deploys it links to it, and so does one you start here.</p>
      {/if}

      {#each groups as group, index (group.id)}
        <h4 class="m-0 px-2.5 pb-1.5 text-xs leading-4 font-normal text-(--solus-text-tertiary) {index === 0 ? 'pt-1' : 'pt-3.5'}">{group.label}</h4>
        {#each group.rows as row (row.sessionId)}
          {@const isSelected = !isStartingNew && row.sessionId === selected?.sessionId}
          {@const mark = providerMark(row.provider)}
          <button
            type="button"
            class="flex w-full min-w-0 cursor-pointer gap-3 overflow-hidden rounded-lg border-0 p-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11 {isSelected
              ? 'bg-[var(--wash-3)]'
              : 'bg-transparent hover:bg-[var(--wash-1)]'}"
            aria-current={isSelected ? "true" : undefined}
            tabindex={isSelected || (!selected && index === 0) ? 0 : -1}
            data-session-id={row.sessionId}
            data-testid="app-session-row"
            onclick={() => select(row.sessionId)}
            ondblclick={() => openSession(row.sessionId)}
          >
            <span class="flex size-7.5 shrink-0 items-center justify-center rounded-[9px] bg-[var(--wash-2)]" aria-hidden="true">
              {#if mark}<ProviderMark {mark} size={15} transparent />{/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.75">
              <span class="flex min-w-0 items-baseline justify-between gap-2">
                <span class="truncate text-sm leading-4.5 text-foreground {isSelected ? 'font-semibold' : ''}">{row.title}</span>
                <span class="shrink-0 text-xs leading-4 text-(--solus-text-tertiary) tabular-nums">{row.time}</span>
              </span>
              <span class="truncate text-[13px] leading-4.5 text-(--solus-text-tertiary)">{row.detail}</span>
            </span>
          </button>
        {/each}
      {/each}
    </nav>

    {#if isStartingNew || selectedLink}
      <AppSessionCard
        {serverId}
        {app}
        link={isStartingNew ? null : selectedLink}
        {now}
        onSend={send}
        onOpen={() => selectedLink && openSession(selectedLink.sessionId)}
        onUnlink={() => selectedLink && void unlink(selectedLink.sessionId)}
        onCancelNew={() => (isStartingNew = false)}
      />
    {/if}
  </div>
{/if}
