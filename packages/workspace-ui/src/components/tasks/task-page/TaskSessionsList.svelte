<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Plus as PlusIcon,
    Square as StopIcon,
  } from "@lucide/svelte";
  import type { TaskSessionLink } from "@solus/contracts/task-types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import * as TooltipUI from "../../ui/tooltip";
  import {
    getSessionSidebarStore,
    getSurfaceContext,
    hostRolesStore,
    isAgentRunningStatus,
    presenceStore,
    serversStore,
  } from "../../../contexts";
  import PresenceStack from "../../presence/PresenceStack.svelte";
  import { activeTurnAuthorOf } from "../../presence/lib/presence-people";
  import SessionStatusGlyph from "../../session/SessionStatusGlyph.svelte";
  import SessionContextMenu from "../../session/SessionContextMenu.svelte";
  import HostOperatingSystemIcon from "../../servers/HostOperatingSystemIcon.svelte";
  import { hostIsManaged } from "../../servers/lib/managed-host";
  import ProviderMark from "../../ui/ProviderMark.svelte";
  import {
    attemptServerId,
    sessionTitle,
    type AttentionState,
  } from "../../../lib/sessionUtils";
  import { orderTaskSessions, taskSessionRow, type TaskSessionHost } from "./lib/task-page";

  interface Props {
    sessions: TaskSessionLink[];
    taskTitle: string;
    onOpen: (sessionId: string) => void;
    /** Open beside the conversation. Null on a client with no companion pane. */
    onOpenSplit: ((sessionId: string) => void) | null;
    /** Stop the session on the host that runs it (`serverId`). */
    onStop: (sessionId: string, serverId: string) => void;
    onUnlink: (sessionId: string) => void;
    /** Start a session on this task. Null where the task's host runs none (the workspace service). */
    onNewSession: (() => void) | null;
    /** Start the task's lead, the session the task is talked to through. Null
     *  once it has one, or where no session can start. */
    onStartLead: (() => void) | null;
    /** True where the section is a tab of its own. The wide table hides four
     *  controls behind hover and spreads the attempt across five columns;
     *  neither survives a thumb, so each attempt becomes a card that states its
     *  own facts and carries its own actions at touch size. */
    stacked?: boolean;
  }

  let {
    sessions,
    taskTitle,
    onOpen,
    onOpenSplit,
    onStop,
    onUnlink,
    onNewSession,
    onStartLead,
    stacked = false,
  }: Props = $props();

  const session = getSurfaceContext();
  // The sidebar's own answer for a session's state, so an attempt wears the
  // glyph its sidebar row wears. The console has no sidebar; there the row
  // knows only whether it runs.
  const sidebarStore = session.workspace ? getSessionSidebarStore() : null;
  const now = Date.now();

  /** Six rows, then "Show all", as the Linked list does. The lead is pinned
   *  first, so the cap never hides it. */
  const CAP = 6;
  let expanded = $state(false);

  // Only "is it running right now" is read live — from the open session, or
  // from the host's status feed for a session with no tab — as that is the one
  // live fact the row acts on (Stop). Everything else comes off the link,
  // except who is in the session: that is the host's roster, so a row can name
  // a teammate in an attempt this client never opened. The lead — the session
  // that owns the task's conversation — is pinned first, above the workers.
  const rows = $derived(
    orderTaskSessions(sessions).map((link) => {
      const taskServerId = link.taskId
        ? session.tasksStore.get(link.taskId).serverId
        : null;
      const linkServerId = attemptServerId({ link, taskServerId });
      const open = session.sessionForHostSession(link.sessionId, linkServerId ?? undefined);
      const serverId = attemptServerId({
        link,
        liveServerId: open?.run.serverId,
        taskServerId,
      });
      const host = serversStore.hostFor(serverId);
      const people = serverId
        ? presenceStore.peopleFocusedOn(serverId, { kind: "session", sessionId: link.sessionId })
        : [];
      const running = open
        ? isAgentRunningStatus(open.status)
        : session.tasksStore.isSessionRunning(serverId, link.sessionId);
      // Stop is an execution RPC: it goes to the host running the session. A
      // cloud task's home runs nothing, so with no connected machine to ask
      // the row offers no Stop rather than one that fails.
      const executionServerId = serverId ? serverConnections.resolveId(serverId) : null;
      const stopServerId =
        executionServerId &&
        hostRolesStore.hasExecution(executionServerId) &&
        serversStore.statusFor(executionServerId) === "online"
          ? executionServerId
          : null;
      // A session runs on one machine, and only a client connected to it can
      // open it. On an organization's task a teammate's session names a
      // machine this client does not have: the row says who ran what, and
      // offers nothing that would fail.
      const isReachable = !!host && !("unknown" in host);
      const attention: AttentionState =
        sidebarStore?.sessionAttention(serverId, link.sessionId) ?? (running ? "running" : null);
      return {
        ...taskSessionRow(
          link,
          open ? sessionTitle(open) : null,
          open?.run.provider ?? null,
          running,
          now,
          taskTitle,
          host &&
            ({
              label: isReachable ? host.label : "Another machine",
              os: "os" in host ? host.os : undefined,
              managed: hostIsManaged(host),
            } satisfies TaskSessionHost),
          taskServerId ? presenceStore.currentUserId(taskServerId) : null,
        ),
        serverId,
        isReachable,
        stopServerId,
        attention,
        people,
        activeUserId: activeTurnAuthorOf(people),
      };
    }),
  );
  const shown = $derived(expanded ? rows : rows.slice(0, CAP));

  type Row = (typeof rows)[number];

  /** The session menu every other session row opens, with this row's run. The
   *  console has no workspace and so no session menu. The row is read live, so
   *  Stop follows the run while the menu is open. */
  let contextMenu = $state<{ sessionId: string; x: number; y: number } | null>(null);
  const contextMenuRow = $derived(
    contextMenu ? rows.find((row) => row.sessionId === contextMenu?.sessionId) ?? null : null,
  );

  function openContextMenu(event: MouseEvent, row: Row) {
    if (!session.workspace) return;
    event.preventDefault();
    event.stopPropagation();
    contextMenu = {
      sessionId: row.sessionId,
      x: event.clientX,
      y: event.clientY,
    };
  }

  /** Shift+F10 or the menu key: the keyboard's right-click, under the row. */
  function openContextMenuFromKeyboard(event: KeyboardEvent, row: Row): boolean {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return false;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu(
      new MouseEvent("contextmenu", { clientX: rect.left + 8, clientY: rect.bottom }),
      row,
    );
    event.preventDefault();
    return true;
  }
</script>

{#if stacked}
  <!-- One card per attempt. The wide table's Agent, Host and Started columns
       become the card's own meta line, and the four hover controls become two
       real buttons: Stop where there is something to stop, Open session always,
       and unlink as the way back out. "Open in split" is not among them —
       there is no second pane on a phone to open into. -->
  <div class="flex flex-col gap-3 pt-3.5">
    <!-- The lead is the way to talk to the task, so starting one is offered
         above the attempts and not as the bar's run, which stays a plain
         attempt. -->
    {#if onStartLead}
      <button
        type="button"
        class="flex h-11 w-full cursor-pointer items-center justify-center gap-[7px] rounded-lg border-0 bg-transparent font-medium text-foreground shadow-[shadow:var(--elev-ring)] active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
        onclick={onStartLead}
      >
        Start lead
      </button>
    {/if}
    {#if !rows.length}
      <div class="px-1 py-3.5 text-muted-foreground">
        No session has worked on this task yet. Start one to run an agent against this task
        with the work linked back here.
      </div>
    {:else}
      {#each rows as row (row.sessionId)}
        <div
          class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
          role="group"
          aria-label={row.title}
          oncontextmenu={(e) => openContextMenu(e, row)}
        >
          <div class="flex items-start gap-2.5 px-[13px] pt-[13px] pb-3">
            <span class="flex size-[26px] shrink-0 items-center justify-center rounded-lg bg-[var(--wash-2)]">
              <SessionStatusGlyph attention={row.attention} />
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="leading-[1.35] font-medium text-pretty">{row.title}</span>
              <span class="flex flex-wrap items-center gap-[7px]">
                {#if row.isLead}
                  <span class="text-muted-foreground">Lead</span>
                  <span class="text-muted-foreground opacity-40" aria-hidden="true">·</span>
                {/if}
                <span class="font-mono text-xs tabular-nums text-muted-foreground"
                  >{row.date}</span
                >
                {#if row.startedBy}
                  <span class="text-muted-foreground opacity-40" aria-hidden="true">·</span>
                  <span class="text-muted-foreground">by {row.startedBy}</span>
                {/if}
                {#if row.agent}
                  <span class="text-muted-foreground opacity-40" aria-hidden="true">·</span>
                  {#if row.agentMark}
                    <span class="flex items-center" role="img" aria-label={row.agent} title={row.agent}>
                      <ProviderMark mark={row.agentMark} size={12} />
                    </span>
                  {:else}
                    <span class="font-mono text-xs text-muted-foreground">{row.agent}</span>
                  {/if}
                {/if}
                {#if row.host}
                  <span
                    class="flex min-w-0 items-center gap-1 text-muted-foreground opacity-70"
                  >
                    <HostOperatingSystemIcon
                      os={row.host.os}
                      managed={row.host.managed}
                      size={11}
                      class="shrink-0"
                    />
                    <span class="truncate">{row.host.label}</span>
                  </span>
                {/if}
                <!-- Who is in this attempt right now, at full ink: the one live
                     fact on the line. The ring marks whose prompt is running,
                     the dot a draft being typed. -->
                <PresenceStack people={row.people} size={16} max={3} activeUserId={row.activeUserId} />
              </span>
            </span>
          </div>

          <div
            class="flex gap-2 border-t border-[var(--hairline)] px-[13px] py-2.5"
          >
            {#if row.running && row.stopServerId}
              {@const stopServerId = row.stopServerId}
              <button
                type="button"
                class="h-[38px] flex-1 cursor-pointer rounded-lg border-0 bg-transparent font-medium text-[color-mix(in_oklch,var(--failure)_70%,var(--foreground))] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--failure)_42%,transparent)] active:bg-[color-mix(in_oklch,var(--failure)_10%,transparent)] [-webkit-tap-highlight-color:transparent]"
                onclick={() => onStop(row.sessionId, stopServerId)}
              >
                Stop
              </button>
            {/if}
            {#if row.isReachable}
              <button
                type="button"
                class="h-[38px] flex-1 cursor-pointer rounded-lg border-0 bg-[var(--wash-2)] font-medium text-foreground active:bg-[var(--wash-3)] [-webkit-tap-highlight-color:transparent]"
                onclick={() => onOpen(row.sessionId)}
              >
                Open session
              </button>
            {:else}
              <span class="flex h-[38px] flex-1 items-center text-muted-foreground">
                Runs on another machine
              </span>
            {/if}
            <button
              type="button"
              class="flex size-[38px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground shadow-[shadow:var(--elev-ring)] active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
              onclick={() => onUnlink(row.sessionId)}
              aria-label="Unlink session"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg
              >
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
{:else}
<!-- Drawn like the Linked list above it: a quiet header, then one line per
     attempt with its state glyph where Linked has its kind icon. No column
     header and no rules — the glyph, the title and a muted meta cluster read
     without them, and a column of Agent / Host / Started labels only restated
     what each row already says. The section keeps the page's
     `text-chrome-dense` rung so it steps with the pointer. -->
<div class="flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2">
    <span class="font-normal text-muted-foreground uppercase">Sessions</span>
    <span class="tabular-nums text-muted-foreground opacity-70">{sessions.length}</span>
    <span class="flex-1" aria-hidden="true"></span>
    <!-- Two ways in. The lead is the session the task is talked to through,
         so it is offered until the task has one; New session is a plain
         attempt at any time. -->
    {#if onStartLead}
      <button
        type="button"
        class="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:bg-[var(--wash-2)] focus-visible:text-foreground focus-visible:outline-none"
        onclick={onStartLead}
      >
        Start lead
      </button>
    {/if}
    {#if onNewSession}
      <button
        type="button"
        class="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:bg-[var(--wash-2)] focus-visible:text-foreground focus-visible:outline-none"
        onclick={onNewSession}
      >
        <PlusIcon size={11} aria-hidden="true" />
        New session
      </button>
    {/if}
  </div>

  {#if !rows.length}
    <div class="px-1 py-3.5 text-muted-foreground">
      {#if onNewSession}
        No session has worked on this task yet. Start one to run an agent against this task
        with the work linked back here.
      {:else}
        No session has worked on this task yet. One run on a machine linked to this
        organization is recorded here.
      {/if}
    </div>
  {:else}
    <div class="flex flex-col">
      {#each shown as row (row.sessionId)}
        <!-- An unreachable row is plain text: it names the session and the
             machine, and keeps only Unlink, which edits this task. -->
        <div
          class={[
            "group flex h-[34px] items-center gap-[11px] rounded-md px-1",
            row.isReachable &&
              "cursor-pointer transition-colors hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none",
          ]}
          role="button"
          tabindex={row.isReachable ? 0 : -1}
          aria-disabled={!row.isReachable}
          aria-label="Open session {row.title}"
          title={row.isReachable ? undefined : "This session runs on another machine."}
          onclick={() => {
            if (row.isReachable) onOpen(row.sessionId);
          }}
          oncontextmenu={(e) => openContextMenu(e, row)}
          onkeydown={(e) => {
            if (e.target !== e.currentTarget || openContextMenuFromKeyboard(e, row)) return;
            if (!row.isReachable) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(row.sessionId);
            }
          }}
        >
          <SessionStatusGlyph attention={row.attention} />

          <span class="flex min-w-0 flex-1 items-center gap-2">
            <span class="min-w-0 truncate" title={row.title}>{row.title}</span>
            <!-- The lead is the one row that is not an attempt: it owns the
                 conversation above, so it says so. -->
            {#if row.isLead}
              <span class="shrink-0 text-muted-foreground">Lead</span>
            {/if}
            <!-- Who is in this attempt right now, from the host's roster. The
                 ring marks whose prompt is running, the dot a draft being typed. -->
            <PresenceStack people={row.people} size={14} max={3} activeUserId={row.activeUserId} />
          </span>

          <!-- Agent and machine, one muted cluster instead of two columns. The
               agent is its logo and the machine its OS logo, each named in the
               tooltip; a host that cannot be named is left out rather than
               defaulting to this machine. -->
          <span
            class="flex max-w-[16rem] shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground opacity-70 @max-[40rem]:hidden"
          >
            {#if row.startedBy}<span class="truncate">by {row.startedBy}</span>{/if}
            {#if row.startedBy && (row.agent || row.host)}<span aria-hidden="true">·</span>{/if}
            {#if row.agent}
              {#if row.agentMark}
                <span class="flex items-center" role="img" aria-label={row.agent} title={row.agent}>
                  <ProviderMark mark={row.agentMark} size={12} />
                </span>
              {:else}
                <span class="truncate">{row.agent}</span>
              {/if}
            {/if}
            {#if row.agent && row.host}<span aria-hidden="true">·</span>{/if}
            {#if row.host}
              <HostOperatingSystemIcon
                os={row.host.os}
                managed={row.host.managed}
                size={12}
                class="shrink-0"
              />
              <span class="truncate">{row.host.label}</span>
            {/if}
          </span>

          <span
            class="w-[52px] shrink-0 text-right tabular-nums text-muted-foreground opacity-65"
            title={row.dateFull}
          >
            {row.date}
          </span>

          <!-- Stop stays in view on a running row: it is the one action a user
               may need without hunting for it. The rest appear on hover or
               focus, as Linked's do; the row itself opens the session. -->
          <span class="flex shrink-0 items-center gap-0.5">
            {#if row.running && row.stopServerId}
              {@const stopServerId = row.stopServerId}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))]"
                      onclick={(e) => {
                        e.stopPropagation();
                        onStop(row.sessionId, stopServerId);
                      }}
                      aria-label="Stop session"
                    >
                      <StopIcon size={11} />
                    </button>
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value="Stop session" />
              </TooltipUI.Root>
            {/if}
            {#if onOpenSplit && row.isReachable}
              {@const openSplit = onOpenSplit}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:opacity-100"
                      onclick={(e) => {
                        e.stopPropagation();
                        openSplit(row.sessionId);
                      }}
                      aria-label="Open in split"
                    >
                      <ArrowSquareOutIcon size={12} />
                    </button>
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value="Open in split" />
              </TooltipUI.Root>
            {/if}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:opacity-100"
                    onclick={(e) => {
                      e.stopPropagation();
                      onUnlink(row.sessionId);
                    }}
                    aria-label="Unlink session"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg
                    >
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value="Unlink session" />
            </TooltipUI.Root>
          </span>
        </div>
      {/each}
      {#if rows.length > shown.length}
        <button
          type="button"
          class="flex h-[30px] cursor-pointer items-center self-start rounded-md px-1 text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          onclick={() => (expanded = true)}
        >
          Show all {rows.length}
        </button>
      {/if}
    </div>
  {/if}
</div>
{/if}

{#if contextMenu && contextMenuRow}
  {@const menu = contextMenu}
  {@const menuRow = contextMenuRow}
  {@const stopServerId = menuRow.running ? menuRow.stopServerId : null}
  <SessionContextMenu
    x={menu.x}
    y={menu.y}
    sessionId={menuRow.sessionId}
    serverId={menuRow.serverId}
    showSplit={!!onOpenSplit && menuRow.isReachable}
    onOpenInSplit={onOpenSplit ? () => onOpenSplit(menuRow.sessionId) : undefined}
    rowActions={{
      onStop: stopServerId ? () => onStop(menuRow.sessionId, stopServerId) : undefined,
    }}
    onClose={() => (contextMenu = null)}
  />
{/if}
