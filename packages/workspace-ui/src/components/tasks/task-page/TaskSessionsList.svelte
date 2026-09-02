<script lang="ts">
  import {
    ArrowRight as ArrowRightIcon,
    ExternalLink as ArrowSquareOutIcon,
    Globe as GlobeIcon,
    Laptop as LaptopIcon,
    LoaderCircle as CircleNotchIcon,
    Plus as PlusIcon,
    Square as StopIcon,
    SquareTerminal as TerminalWindowIcon,
  } from "@lucide/svelte";
  import type { TaskSessionLink } from "@solus/contracts/task-types";
  import * as TooltipUI from "../../ui/tooltip";
  import { getWorkspaceContext, serversStore } from "../../../contexts";
  import {
    attemptServerId,
    getAttentionState,
    openSessionFor,
    sessionTitle,
  } from "../../../lib/sessionUtils";
  import { taskSessionRow, type TaskSessionHost } from "./lib/task-page";

  interface Props {
    sessions: TaskSessionLink[];
    taskTitle: string;
    onOpen: (sessionId: string) => void;
    onOpenSplit: (sessionId: string) => void;
    onStop: (sessionId: string) => void;
    onUnlink: (sessionId: string) => void;
    onNewSession: () => void;
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
    stacked = false,
  }: Props = $props();

  const session = getWorkspaceContext();
  const now = Date.now();

  // Only "is it running right now" is read from the live session — that is the
  // one live fact the row acts on (Stop). Everything else comes off the link.
  const rows = $derived(
    sessions.map((link) => {
      const linkServerId = attemptServerId({
        link,
        taskServerId: link.taskId
          ? session.tasksStore.get(link.taskId).serverId
          : null,
      });
      const open = openSessionFor(link.sessionId, linkServerId, session);
      const host = serversStore.hostFor(
        attemptServerId({
          link,
          liveServerId: open?.session.run.serverId,
          taskServerId: link.taskId
            ? session.tasksStore.get(link.taskId).serverId
            : null,
        }),
      );
      return taskSessionRow(
        link,
        open ? sessionTitle(open.session) : null,
        open?.session.run.provider ?? null,
        !!open && getAttentionState(open.session, open.tab) === "running",
        now,
        taskTitle,
        host && ({ label: host.label, isRemote: !host.local } satisfies TaskSessionHost),
      );
    }),
  );
</script>

{#if stacked}
  <!-- One card per attempt. The wide table's Agent, Host and Started columns
       become the card's own meta line, and the four hover controls become two
       real buttons: Stop where there is something to stop, Open session always,
       and unlink as the way back out. "Open in split" is not among them —
       there is no second pane on a phone to open into. -->
  <div class="flex flex-col gap-3 pt-3.5">
    {#if !rows.length}
      <div class="px-1 py-3.5 text-muted-foreground">
        No session has worked on this task yet. Start one to run an agent against this task
        with the work linked back here.
      </div>
    {:else}
      {#each rows as row (row.sessionId)}
        <div
          class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
        >
          <div class="flex items-start gap-2.5 px-[13px] pt-[13px] pb-3">
            <span
              class="flex size-[26px] shrink-0 items-center justify-center rounded-lg {row.running
                ? 'bg-[color-mix(in_oklch,var(--running)_20%,transparent)] text-[color-mix(in_oklch,var(--running)_62%,var(--foreground))]'
                : 'bg-[var(--wash-3)] text-muted-foreground'}"
              aria-hidden="true"
            >
              {#if row.running}
                <CircleNotchIcon
                  size={14}
                  class="animate-spin motion-reduce:animate-none"
                />
              {:else}
                <TerminalWindowIcon size={14} />
              {/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="leading-[1.35] font-medium text-pretty">{row.title}</span>
              <span class="flex flex-wrap items-center gap-[7px]">
                {#if row.running}
                  <span
                    class="text-[color-mix(in_oklch,var(--running)_72%,var(--foreground))]"
                    >running</span
                  >
                {/if}
                <span class="font-mono text-xs tabular-nums text-muted-foreground"
                  >{row.date}</span
                >
                {#if row.agent}
                  <span class="text-muted-foreground opacity-40" aria-hidden="true">·</span>
                  <span class="font-mono text-xs text-muted-foreground">{row.agent}</span>
                {/if}
                {#if row.host}
                  <span
                    class="flex min-w-0 items-center gap-1 text-muted-foreground opacity-70"
                  >
                    {#if row.host.isRemote}
                      <GlobeIcon size={11} class="shrink-0" aria-hidden="true" />
                    {:else}
                      <LaptopIcon size={11} class="shrink-0" aria-hidden="true" />
                    {/if}
                    <span class="truncate">{row.host.label}</span>
                  </span>
                {/if}
              </span>
            </span>
          </div>

          <div
            class="flex gap-2 border-t border-[var(--hairline)] px-[13px] py-2.5"
          >
            {#if row.running}
              <button
                type="button"
                class="h-[38px] flex-1 cursor-pointer rounded-lg border-0 bg-transparent font-medium text-[color-mix(in_oklch,var(--failure)_70%,var(--foreground))] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--failure)_42%,transparent)] active:bg-[color-mix(in_oklch,var(--failure)_10%,transparent)] [-webkit-tap-highlight-color:transparent]"
                onclick={() => onStop(row.sessionId)}
              >
                Stop
              </button>
            {/if}
            <button
              type="button"
              class="h-[38px] flex-1 cursor-pointer rounded-lg border-0 bg-[var(--wash-2)] font-medium text-foreground active:bg-[var(--wash-3)] [-webkit-tap-highlight-color:transparent]"
              onclick={() => onOpen(row.sessionId)}
            >
              Open session
            </button>
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
<!-- The section takes the page's `text-chrome-dense` rung rather than pinning
     `text-xs`: the rung is what steps for the pointer, and a section that
     restates a size stops stepping with the page. -->
<div class="flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2.5">
    <span class="font-normal text-muted-foreground uppercase">
      Sessions
    </span>
    <span class="tabular-nums text-muted-foreground opacity-70">
      {sessions.length}
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
    <button
      type="button"
      class="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground [.is-laptop-display_&]:h-[22px] [.is-laptop-display_&]:px-2"
      onclick={onNewSession}
    >
      <PlusIcon size={11} weight="bold" aria-hidden="true" />
      New session
    </button>
  </div>

  <!-- Attempts are a history, so they are read down a column, not across two
       lines each: agent, machine and date line up between rows and a long
       history stays scannable. The card is bounded so it cannot push the rest
       of the task off the page, and the header stays put while it scrolls.
       With no attempt yet there is no card to bound — the section says so in the
       same plain line the Linked table uses, and New session above is the way in. -->
  {#if !rows.length}
    <div class="px-1 py-3.5 text-muted-foreground">
      No session has worked on this task yet. Start one to run an agent against this task
      with the work linked back here.
    </div>
  {:else}
    <div
      class="scrollbar-on-hover max-h-[min(22rem,42vh)] overflow-y-auto overscroll-contain rounded-xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)] [.is-laptop-display_&]:rounded-lg"
    >
      <!-- Sticky so the columns stay named through a long history. It carries
           the card's own fill, or rows would read through it as it scrolls. -->
      <div
        class="sticky top-0 z-10 flex h-[27px] items-center gap-[11px] bg-card pr-2 pl-[13px] font-normal text-muted-foreground uppercase opacity-75 shadow-[0_.5px_0_var(--hairline)] [.is-laptop-display_&]:h-[24px] [.is-laptop-display_&]:gap-2 [.is-laptop-display_&]:pl-[11px]"
        aria-hidden="true"
      >
        <span class="w-3.5 shrink-0"></span>
        <span class="min-w-0 flex-1">Session</span>
        <span class="w-[104px] shrink-0 @max-[34rem]:hidden [.is-laptop-display_&]:w-[92px]">
          Agent
        </span>
        <span class="w-[128px] shrink-0 @max-[46rem]:hidden [.is-laptop-display_&]:w-[110px]">
          Host
        </span>
        <span class="w-[72px] shrink-0 text-right [.is-laptop-display_&]:w-[64px]">Started</span>
        <!-- Sized for four controls, which is what a running row has: the cell
             is `shrink-0` all the way down, so a width sized for three does not
             clip the fourth, it paints it over Started. -->
        <span class="w-[116px] shrink-0 [.is-laptop-display_&]:w-[100px]"></span>
      </div>

      {#each rows as row (row.sessionId)}
        <div
          class="group flex h-[34px] cursor-pointer items-center gap-[11px] border-t-[.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] pr-2 pl-[13px] transition-colors first:border-t-0 hover:bg-[var(--wash-1)] [.is-laptop-display_&]:h-[30px] [.is-laptop-display_&]:gap-2 [.is-laptop-display_&]:pl-[11px]"
          role="button"
          tabindex="0"
          title={row.dateFull}
          onclick={() => onOpen(row.sessionId)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(row.sessionId);
            }
          }}
        >
          <span class="flex size-3.5 shrink-0 items-center justify-center">
            <TerminalWindowIcon
              size={13}
              class="text-muted-foreground opacity-55"
              aria-hidden="true"
            />
          </span>

          <!-- Running is stated only where it is true, beside the title it
               belongs to. There is no state column: what a closed session did
               next is unknowable, and a column of blanks would claim otherwise. -->
          <span class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span class="min-w-0 truncate font-medium">{row.title}</span>
            {#if row.running}
              <span
                class="shrink-0 text-[color-mix(in_oklch,var(--running)_62%,var(--foreground))]"
              >
                Running
              </span>
            {/if}
          </span>

          <span
            class="w-[104px] shrink-0 truncate text-muted-foreground opacity-70 @max-[34rem]:hidden [.is-laptop-display_&]:w-[92px]"
          >
            {row.agent}
          </span>

          <!-- The same laptop/globe pair the sidebar uses, so one machine reads
               the same way wherever it is named. A host that cannot be named is
               left blank rather than defaulting to this machine. -->
          <span
            class="flex w-[128px] shrink-0 items-center gap-1 overflow-hidden text-muted-foreground opacity-70 @max-[46rem]:hidden [.is-laptop-display_&]:w-[110px]"
          >
            {#if row.host}
              {#if row.host.isRemote}
                <GlobeIcon size={11} class="shrink-0" aria-hidden="true" />
              {:else}
                <LaptopIcon size={11} class="shrink-0" aria-hidden="true" />
              {/if}
              <span class="truncate">{row.host.label}</span>
            {/if}
          </span>

          <span
            class="w-[72px] shrink-0 text-right tabular-nums text-muted-foreground opacity-65 [.is-laptop-display_&]:w-[64px]"
          >
            {row.date}
          </span>

          <!-- The actions keep a column of their own so the date above stays
               aligned when a row reveals them. They appear on hover, except on a
               running row: Stop is the one action a user may need without
               hunting for it. -->
          <span
            class="flex w-[116px] shrink-0 items-center justify-end gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 [.is-laptop-display_&]:w-[100px] {row.running
              ? 'opacity-100'
              : 'opacity-0'}"
          >
            {#if row.running}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))] [.is-laptop-display_&]:size-[22px]"
                      onclick={(e) => {
                        e.stopPropagation();
                        onStop(row.sessionId);
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
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground [.is-laptop-display_&]:size-[22px]"
                    onclick={(e) => {
                      e.stopPropagation();
                      onOpenSplit(row.sessionId);
                    }}
                    aria-label="Open in split"
                  >
                    <ArrowSquareOutIcon size={13} />
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value="Open in split" />
            </TooltipUI.Root>
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground [.is-laptop-display_&]:size-[22px]"
                    onclick={(e) => {
                      e.stopPropagation();
                      onOpen(row.sessionId);
                    }}
                    aria-label="Open session"
                  >
                    <ArrowRightIcon size={13} />
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value="Open session" />
            </TooltipUI.Root>
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground [.is-laptop-display_&]:size-[22px]"
                    onclick={(e) => {
                      e.stopPropagation();
                      onUnlink(row.sessionId);
                    }}
                    aria-label="Unlink session"
                  >
                    <svg
                      width="11"
                      height="11"
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
    </div>
  {/if}
</div>
{/if}
