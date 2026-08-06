<script lang="ts">
  import { ArrowRightIcon, ArrowSquareOutIcon, StopIcon } from "phosphor-svelte";
  import type { TaskSessionLink } from "../../../../shared/task-types";
  import * as TooltipUI from "../../ui/tooltip";
  import { getWorkspaceContext } from "../../../contexts";
  import { getAttentionState, openSessionFor, sessionTitle } from "../../../lib/sessionUtils";
  import { taskSessionRow } from "./lib/task-page";

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
      return taskSessionRow(
        link,
        open ? sessionTitle(open.session, open.tab) : null,
        open?.session.run.provider ?? null,
        !!open && getAttentionState(open.session, open.tab) === "running",
        now,
        taskTitle,
      );
    }),
  );
</script>

<div class="flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2.5">
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

  <!-- The list sits on its own card so the attempts read as one object against
       the page, rather than as loose rows. No column header: the section header
       above is the only header this needs, and "Session" under "Sessions" reads
       as a stutter. -->
  <div
    class="flex flex-col overflow-hidden rounded-xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
  >
    {#each rows as row, index (row.sessionId)}
      <div
        class="group flex h-[38px] cursor-pointer items-center gap-[11px] px-3 transition-colors hover:bg-[var(--wash-1)] {index >
        0
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
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <!-- The only live marker left: a dot while the agent is working. -->
          {#if row.running}
            <span
              class="size-[6px] shrink-0 animate-pulse rounded-full bg-[var(--running)]"
              title="Running"
            ></span>
          {/if}
          <span class="min-w-0 truncate text-[13px] tracking-[-.006em]">{row.title}</span>
        </span>

        <span class="w-[104px] shrink-0 truncate text-[12px] text-muted-foreground opacity-75">
          {row.agent}
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
