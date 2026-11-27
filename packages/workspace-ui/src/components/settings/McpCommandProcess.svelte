<script lang="ts">
  /**
   * The caller's process of one command (docs/plans/mcp-first-class.md §7.7):
   * its state in words, what the host said, the last standard error, and the
   * actions that change it. Stop and Cancel stay on for a person without
   * `host.admin`; the actions that start the command say why they are off.
   */
  import { tick } from "svelte";
  import { ChevronRight, CircleCheck, LoaderCircle } from "@lucide/svelte";
  import type { CommandProcessActionKind } from "@solus/contracts/integrations/command-server";
  import type { Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { mcpStore } from "../../contexts/mcp";

  interface Props {
    serverId: string;
    integration: Integration;
    mayRunCommands: boolean;
    /** The add dialog has its own Start and test and Cancel: it shows the state and the error only. */
    withActions?: boolean;
  }

  let { serverId, integration, mayRunCommands, withActions = true }: Props = $props();

  let rootEl = $state<HTMLDivElement | null>(null);

  const hostState = $derived(mcpStore.integrations.states.get(serverId));
  const isOffline = $derived(!!hostState?.isDisconnected);
  const status = $derived(hostState?.processes.statusOf(integration, hostState.connections.get(integration.id), mayRunCommands));
  const processError = $derived(hostState?.processes.errorOf(integration.id));

  async function run(kind: CommandProcessActionKind) {
    await hostState?.processes.run(integration.id, kind);
    // The next control the person needs takes the focus: the new main action.
    await tick();
    rootEl?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }
</script>

{#if status}
  <div bind:this={rootEl} class="flex flex-col gap-2" data-testid="command-process" data-state={status.state}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0 flex-1">
        <p role="status" class="flex items-center gap-2 text-workspace-chrome {status.tone === 'error' ? 'text-(--solus-status-error)' : status.tone === 'ready' ? 'text-foreground' : 'text-(--solus-text-secondary)'}">
          {#if status.state === "starting"}<LoaderCircle size={14} class="shrink-0 animate-spin motion-reduce:animate-none" />{/if}
          {#if status.tone === "ready"}<CircleCheck size={14} class="shrink-0 text-(--solus-status-complete)" aria-hidden="true" />{/if}
          {status.label}
        </p>
        {#if status.detail}
          <p class="break-words text-chrome-dense text-(--solus-text-secondary)">{status.detail}</p>
        {/if}
      </div>
      {#if withActions && status.actions.length > 0}
        <div class="flex flex-wrap items-center gap-2">
          {#each status.actions as action, index (action.kind)}
            <Button variant={index === 0 ? "outline" : "ghost"} size="sm" class="text-workspace-chrome pointer-coarse:min-h-11 {index === 0 ? '' : 'text-muted-foreground'}"
              disabled={!action.isEnabled || isOffline} aria-describedby={!action.isEnabled ? `command-blocked-${integration.id}` : undefined}
              onclick={() => run(action.kind)}>{action.label}</Button>
          {/each}
        </div>
      {/if}
    </div>
    {#if processError}
      <p role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{processError}</p>
    {/if}
    {#if withActions && status.blockedReason}
      <p id="command-blocked-{integration.id}" class="text-chrome-dense text-(--solus-text-secondary)">{status.blockedReason}</p>
    {/if}
    {#if status.stderrTail}
      <details class="group text-chrome-dense">
        <summary class="-ml-1 flex min-h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-(--solus-text-secondary) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} class="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />Standard error
        </summary>
        <pre class="mt-1 max-h-48 overflow-auto rounded-lg bg-muted p-2.5 font-mono text-chrome-dense whitespace-pre-wrap break-words text-foreground">{status.stderrTail}</pre>
      </details>
    {/if}
  </div>
{/if}
