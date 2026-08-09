<script lang="ts">
  import {
    ArrowRightIcon,
    ArrowSquareOutIcon,
    GlobeIcon,
    LaptopIcon,
    StopIcon,
  } from "phosphor-svelte";
  import type { TaskSessionLink } from "../../../../shared/task-types";
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
    onNewSession: () => void;
  }

  let { sessions, taskTitle, onOpen, onOpenSplit, onStop, onNewSession }: Props = $props();

  const session = getWorkspaceContext();
  const now = Date.now();

  // Only "is it running right now" is read from the live session — that is the
  // one live fact the row acts on (Stop). Everything else comes off the link.
  const rows = $derived(
    sessions.map((link) => {
      const open = openSessionFor(link.sessionId, session);
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
</script>

<div class="flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2">
    <span class="text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase">
      Sessions
    </span>
    <span class="font-mono text-[11px] tabular-nums text-muted-foreground opacity-70">
      {sessions.length}
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
    <button
      type="button"
      class="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={onNewSession}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        aria-hidden="true"><path d="M7 2.6v8.8M2.6 7h8.8" /></svg
      >
      New session
    </button>
  </div>

  <!-- Same flat table as the linked section above: a column header, then rows
       separated by hairlines. No card, so both sections read as one grammar. -->
  <div class="flex flex-col">
    <div
      class="flex h-6 items-center gap-[11px] border-b-[.5px] border-[var(--hairline)] px-1"
      aria-hidden="true"
    >
      <span class="w-3.5 shrink-0"></span>
      <span
        class="min-w-0 flex-1 text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase opacity-75"
      >
        Session
      </span>
      <span
        class="w-[92px] shrink-0 text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase opacity-75"
      >
        Agent
      </span>
      <!-- Attempts of one task can sit on different machines, and after the fact
           that is the only thing distinguishing them. -->
      <span
        class="w-[104px] shrink-0 text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase opacity-75"
      >
        Ran on
      </span>
      <span
        class="w-[88px] shrink-0 text-right text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase opacity-75"
      >
        Active
      </span>
    </div>
    {#each rows as row (row.sessionId)}
      <div
        class="group flex h-[33px] cursor-pointer items-center gap-[11px] border-b-[.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] px-1 transition-colors hover:bg-[var(--wash-1)]"
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
        <!-- The only live marker left: a dot while the agent is working. It sits
             in the icon slot so the title column lines up with the header. -->
        <span class="flex size-3.5 shrink-0 items-center justify-center">
          {#if row.running}
            <span
              class="size-[6px] animate-pulse rounded-full bg-[var(--running)]"
              title="Running"
            ></span>
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate text-[13px] tracking-[-.006em]">{row.title}</span>

        <span class="w-[92px] shrink-0 truncate text-[12px] text-muted-foreground opacity-70">
          {row.agent}
        </span>

        <!-- The same laptop/globe pair the sidebar uses, so one machine reads
             the same way wherever it is named. A host that cannot be named is
             left as a dash rather than defaulting to this machine. -->
        <span
          class="flex w-[104px] shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground opacity-70"
        >
          {#if row.host}
            {#if row.host.isRemote}
              <GlobeIcon size={12} class="shrink-0" aria-hidden="true" />
            {:else}
              <LaptopIcon size={12} class="shrink-0" aria-hidden="true" />
            {/if}
            <span class="truncate">{row.host.label}</span>
          {:else}
            <span aria-label="Unknown host">—</span>
          {/if}
        </span>

        <!-- The date reads at rest and hands its slot to the actions on hover,
             so the row never carries a column of unlabelled icons. -->
        <span class="relative flex w-[88px] shrink-0 items-center justify-end">
          <span
            class="text-[12px] whitespace-nowrap text-muted-foreground opacity-70 transition-opacity group-hover:opacity-0"
          >
            {row.date}
          </span>
          <!-- Icon buttons, each with a tooltip: the row can't afford three
               words, and an unlabelled glyph is only fair if hovering says
               what it does. -->
          <span
            class="absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          >
            {#if row.running}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="flex size-[24px] cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))]"
                      onclick={(e) => {
                        e.stopPropagation();
                        onStop(row.sessionId);
                      }}
                      aria-label="Stop session"
                    >
                      <StopIcon size={13} weight="fill" />
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
                    class="flex size-[24px] cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
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
                    class="flex size-[24px] cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
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
          </span>
        </span>
      </div>
    {/each}
  </div>
</div>
