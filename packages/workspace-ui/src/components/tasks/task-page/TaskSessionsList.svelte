<script lang="ts">
  import {
    ArrowRightIcon,
    ArrowSquareOutIcon,
    GlobeIcon,
    LaptopIcon,
    PlusIcon,
    StopIcon,
    TerminalWindowIcon,
  } from "phosphor-svelte";
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
  }

  let { sessions, taskTitle, onOpen, onOpenSplit, onStop, onUnlink, onNewSession }: Props = $props();

  const session = getWorkspaceContext();
  const now = Date.now();

  // Only "is it running right now" is read from the live session — that is the
  // one live fact the row acts on (Stop). Everything else comes off the link.
  const rows = $derived(
    sessions.map((link) => {
      const linkServerId = attemptServerId({
        link,
        taskServerId: session.tasksStore.hostFor(link.taskId),
      });
      const open = openSessionFor(link.sessionId, linkServerId, session);
      const host = serversStore.hostFor(
        attemptServerId({
          link,
          liveServerId: open?.session.run.serverId,
          taskServerId: session.tasksStore.hostFor(link.taskId),
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

  const ROW_ACTION =
    "flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground";
</script>

<div class="text-xs text-xs flex flex-col gap-[7px] pt-[26px]">
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
      class="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={onNewSession}
    >
      <PlusIcon size={11} weight="bold" aria-hidden="true" />
      New session
    </button>
  </div>

  <!-- An attempt is a small story, not a table cell: the card gives each one two
       lines, so the title reads as a title and the facts that tell two attempts
       of the same task apart — agent, machine, when — sit under it. The card is
       bounded so a long history does not push the rest of the task off the page. -->
  <div
    class="scrollbar-on-hover max-h-[min(22rem,42vh)] overflow-y-auto overscroll-contain rounded-xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
  >
    {#each rows as row, index (row.sessionId)}
      <div
        class="group flex cursor-pointer items-center gap-[11px] py-2.5 pr-2.5 pl-[13px] transition-colors hover:bg-[var(--wash-1)] {index
          ? 'border-t-[.5px] border-[var(--hairline)]'
          : ''}"
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
          {#if row.running}
            <span
              class="size-[7px] animate-pulse rounded-full bg-[var(--running)] motion-reduce:animate-none"
              aria-hidden="true"
            ></span>
          {:else}
            <TerminalWindowIcon
              size={13}
              class="text-muted-foreground opacity-55"
              aria-hidden="true"
            />
          {/if}
        </span>

        <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span class="truncate font-medium">{row.title}</span>
          <span class="flex min-w-0 items-center gap-[7px]">
            {#if row.running}
              <span class="shrink-0 text-[color-mix(in_oklch,var(--running)_62%,var(--foreground))]">
                Running
              </span>
              <span class="text-muted-foreground opacity-35" aria-hidden="true">·</span>
            {/if}
            {#if row.agent}
              <span class="shrink-0 truncate text-muted-foreground opacity-70">
                {row.agent}
              </span>
              <span class="text-muted-foreground opacity-35" aria-hidden="true">·</span>
            {/if}
            <!-- The same laptop/globe pair the sidebar uses, so one machine reads
                 the same way wherever it is named. A host that cannot be named is
                 left out rather than defaulting to this machine. -->
            {#if row.host}
              <span
                class="flex min-w-0 shrink items-center gap-1 text-muted-foreground opacity-70"
              >
                {#if row.host.isRemote}
                  <GlobeIcon size={11} class="shrink-0" aria-hidden="true" />
                {:else}
                  <LaptopIcon size={11} class="shrink-0" aria-hidden="true" />
                {/if}
                <span class="truncate">{row.host.label}</span>
              </span>
              <span class="text-muted-foreground opacity-35" aria-hidden="true">·</span>
            {/if}
            <span class="shrink-0 tabular-nums text-muted-foreground opacity-65">
              {row.date}
            </span>
          </span>
        </span>

        <!-- Actions appear on hover, and stay put on a running row: Stop is the
             one action a user may need without hunting for it. -->
        <span
          class="flex shrink-0 items-center gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 {row.running
            ? 'opacity-100'
            : 'opacity-0'}"
        >
          {#if row.running}
            <button
              type="button"
              class="flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))] hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--failure)_45%,transparent)]"
              onclick={(e) => {
                e.stopPropagation();
                onStop(row.sessionId);
              }}
              aria-label="Stop session"
            >
              <StopIcon size={10} weight="fill" aria-hidden="true" />
              Stop
            </button>
          {/if}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class={ROW_ACTION}
                  onclick={(e) => {
                    e.stopPropagation();
                    onOpenSplit(row.sessionId);
                  }}
                  aria-label="Open in split"
                >
                  <ArrowSquareOutIcon size={14} />
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
                  class={ROW_ACTION}
                  onclick={(e) => {
                    e.stopPropagation();
                    onOpen(row.sessionId);
                  }}
                  aria-label="Open session"
                >
                  <ArrowRightIcon size={14} />
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
                  class={ROW_ACTION}
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
</div>
