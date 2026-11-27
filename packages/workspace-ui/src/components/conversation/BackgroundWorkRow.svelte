<script lang="ts">
  import {
    ArrowUpRight as ArrowUpRightIcon,
    Bot as SubagentIcon,
    Clock as ScheduleIcon,
    Eye as MonitorIcon,
    Server as ServerIcon,
    SquareTerminal as CommandIcon,
    Workflow as WorkflowIcon,
  } from "@lucide/svelte";
  import type { BackgroundTaskKind } from "@solus/contracts/types";
  import { formatShellCommand } from "@solus/client-core/tool-call-code";
  import ActivityRow from "./ActivityRow.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import DotMatrix from "../ui/DotMatrix.svelte";
  import BackgroundStopButton from "./BackgroundStopButton.svelte";
  import type { BackgroundWait, BackgroundWorkEntry } from "./lib/activity-summary";
  import { revealTurnItem } from "./lib/reveal-in-transcript";
  import { requestInputFocus } from "../../lib/inputFocus";
  import TaskStatusGlyph from "../session/TaskStatusGlyph.svelte";

  /**
   * The session's background work, stated where the live row would be: at
   * the end of the last turn, beside the composer. It shows in `background`,
   * and after a completed turn while work the agent did not mark (a dev
   * server, its Monitor) still runs (`showsBackgroundWork`). The turn's own summary row
   * sits above a long answer, where nobody looks for what is still going on.
   *
   * It takes the Running dot mark and the live row's shimmer: the work is
   * still running, even though the turn is finished.
   *
   * Its Stop ends only the background work. The session Stop interrupts a turn,
   * and this turn already finished, so it would report a stop that never
   * happened to it.
   *
   * A wait on other agent sessions is not work this session does: the session
   * is idle and takes a new message at once. So its one sentence says the
   * agents work in the background, the row takes the Delegating mark without
   * the shimmer, and it scrolls to the cards it waits on.
   * When one of those agents waits on you, the row takes the Input glyph its
   * card shows and scrolls to that card, where you answer it.
   *
   * Otherwise the row is a disclosure: a click opens, under the row, each
   * task the session runs (`entries`) and every address its agent's servers
   * still listen on. The row prints the first address; the detail's link opens
   * the Running servers list, which shows and stops them.
   */
  interface Props {
    wait: BackgroundWait;
    /** Each task of the background work, listed when the row opens. */
    entries?: readonly BackgroundWorkEntry[];
    /** The addresses of the servers the session's agent left running. */
    serverAddresses?: readonly string[];
    onShowServers?: () => void;
    /** Resolves once the host has taken the request; the row goes away when
     *  the tasks settle. */
    onStop: () => Promise<void>;
  }
  let { wait, entries = [], serverAddresses = [], onShowServers, onStop }: Props = $props();
  const serversText = $derived(
    serverAddresses.length > 1 ? `${serverAddresses[0]} +${serverAddresses.length - 1}` : (serverAddresses[0] ?? ""),
  );

  const KIND_ICONS = {
    command: CommandIcon,
    monitor: MonitorIcon,
    subagent: SubagentIcon,
    workflow: WorkflowIcon,
    schedule: ScheduleIcon,
  } satisfies Record<BackgroundTaskKind, unknown>;

  let isStopping = $state(false);
  let expanded = $state(false);

  function showAgents(event: MouseEvent): void {
    if (wait.agentCardKey && event.currentTarget instanceof HTMLElement) {
      revealTurnItem(event.currentTarget, wait.agentCardKey);
    }
  }

  function showServers(): void {
    onShowServers?.();
    requestInputFocus();
  }

  async function stop(): Promise<void> {
    isStopping = true;
    try {
      await onStop();
    } finally {
      isStopping = false;
    }
  }
</script>

{#snippet commandText()}{wait.command || serversText}{/snippet}

{#snippet fullText()}
  {#if entries.length}
    <ul class="background-entries" data-testid="background-work-entries">
      {#each entries as entry (entry.key)}
        {@const Icon = KIND_ICONS[entry.kind]}
        <li class="background-entry" title={entry.kindName}>
          <Icon class="background-entry-icon" aria-label={entry.kindName} />
          {#if entry.isCommand}
            <div class="background-code [&_pre]:max-h-80 [&_pre]:overflow-y-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere" data-slot="tool-call-code">
              <CodeBlock text={formatShellCommand(entry.text)} lang="bash" />
            </div>
          {:else}
            <span class="background-description">{entry.text}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="m-0 whitespace-pre-wrap break-words text-(length:--text-activity-label) leading-relaxed text-muted-foreground">{wait.label}</p>
    {#if wait.command}
      <div class="mt-1.5"><div class="background-code [&_pre]:max-h-80 [&_pre]:overflow-y-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere" data-slot="tool-call-code">
        <CodeBlock text={formatShellCommand(wait.command)} lang="bash" />
      </div></div>
    {/if}
  {/if}
  {#if serverAddresses.length}
    <div class="background-entry background-servers" data-testid="background-work-servers">
      <ServerIcon class="background-entry-icon" aria-label={serverAddresses.length === 1 ? "Server" : "Servers"} />
      <span class="flex min-w-0 flex-wrap items-center gap-1">
        {#each serverAddresses as address (address)}
          <span class="background-address">{address}</span>
        {/each}
        {#if onShowServers}
          <button type="button" class="background-show-servers" onclick={showServers} data-testid="background-work-show-servers">
            Running servers<ArrowUpRightIcon aria-hidden="true" />
          </button>
        {/if}
      </span>
    </div>
  {/if}
{/snippet}

<!-- Stop sits on the rail, where a finished row keeps its step count, and takes
     the rail's own type: the row adds a control, not a new style. -->
{#snippet stopRail()}
  <BackgroundStopButton
    label={isStopping ? "Stopping the background work" : "Stop the background work"}
    title={isStopping ? "Stopping…" : "Stop the background work"}
    disabled={isStopping}
    onclick={stop}
    testid="background-work-stop"
  />
{/snippet}

<ActivityRow
  target={wait.command || serversText ? commandText : undefined}
  rail={stopRail}
  onActivate={wait.agentCardKey ? showAgents : undefined}
  onToggle={wait.agentCardKey ? undefined : () => (expanded = !expanded)}
  {expanded}
  detail={fullText}
  testid="background-work-row"
>
  {#snippet glyph()}
    {#if wait.agentsNeedYou}
      <TaskStatusGlyph status="question" label={wait.label} size={15} showsWord={false} />
    {:else}
      <span class="flex items-center text-(--solus-status-working)"><DotMatrix mark={wait.agentCardKey ? "delegating" : "running"} /></span>
    {/if}
  {/snippet}
  {#snippet label()}<span class:activity-shimmer={!wait.agentCardKey}>{wait.label}</span>{/snippet}
</ActivityRow>

<style>
  .background-entries {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* An icon column, then the work: the kind is the icon, so the text gets the width. */
  .background-entry {
    display: grid;
    grid-template-columns: 0.875rem minmax(0, 1fr);
    align-items: start;
    column-gap: 0.5rem;
    font-size: var(--text-activity-label);
    line-height: 1.25rem;
  }

  .background-servers {
    margin-top: 0.625rem;
    align-items: center;
  }

  .background-entry :global(.background-entry-icon) {
    width: 0.875rem;
    height: 0.875rem;
    /* Centres the icon on the first line of a wrapped entry. */
    margin-top: 0.1875rem;
    color: var(--muted-foreground);
  }

  .background-servers :global(.background-entry-icon) {
    margin-top: 0;
  }

  .background-description {
    color: var(--foreground);
    overflow-wrap: anywhere;
  }

  /* The command takes the code block an expanded tool call uses: the shell's
     own statements on their own lines, highlighted as bash. */
  .background-code {
    min-width: 0;
  }

  .background-address {
    padding: 0 0.375rem;
    border-radius: 0.3125rem;
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: var(--text-tool-step);
    line-height: 1.25rem;
  }

  .background-show-servers {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    margin-left: 0.25rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-tool-step);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }

  .background-show-servers:hover {
    color: var(--foreground);
  }

  .background-show-servers :global(svg) {
    width: 0.75rem;
    height: 0.75rem;
  }
</style>
