<script lang="ts">
  /**
   * One found server (docs/plans/mcp-first-class.md §8.6): its name, the full
   * command or URL as the host read it, the files it is in, and Add, Review
   * change, or why it cannot be added. Follows the installed row
   * (`McpServerRow`): the same padding, icon, name, and supporting text.
   * A server that runs on the host's loopback (§9.2) names its port and
   * process, and what it said about itself, which Solus did not verify.
   */
  import { Check, TriangleAlert } from "@lucide/svelte";
  import type { FoundServer } from "@solus/contracts/integration-types";
  import { foundPlacesText, foundPortOf, foundStateText, foundTargetText, foundUnsupportedText, portIdentityText, projectCommandWarning } from "@solus/contracts/integrations/found-server-labels";
  import { Button } from "../ui/button";
  import McpServerIcon from "./McpServerIcon.svelte";

  interface Props {
    server: FoundServer;
    /** The name of the project whose files were read, for the warning on a project row. */
    projectName: string | null;
    /** The host whose loopback a running server is on. */
    hostLabel: string;
    isOffline: boolean;
    isAdding: boolean;
    onReview: (server: FoundServer) => void;
  }
  let { server, projectName, hostLabel, isOffline, isAdding, onReview }: Props = $props();

  const target = $derived(foundTargetText(server));
  const url = $derived(server.transport && server.transport.kind !== "stdio" ? server.transport.url : "");
  const port = $derived(foundPortOf(server));
</script>

<div class="flex flex-col gap-2 px-4 py-3" data-testid="mcp-found-row" data-found-id={server.foundId}>
  <div class="flex min-w-0 items-start gap-3">
    <McpServerIcon name={server.name} {url} />
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-workspace-chrome leading-5 font-medium text-foreground" title={server.name}>{server.name}</span>
      <!-- The full command: the person reads exactly what would run before they add it. -->
      {#if target}<code class="font-mono text-chrome-dense leading-5 break-all text-(--solus-text-secondary)">{target}</code>{/if}
      <span class="text-chrome-dense leading-5 text-(--solus-text-tertiary)">{foundPlacesText(server, hostLabel)}</span>
    </div>
    {#if server.state === "new"}
      <Button variant="outline" size="sm" class="shrink-0 border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={isOffline || isAdding}
        onclick={() => onReview(server)} aria-label="Add {server.name}">Add</Button>
    {:else if server.state === "changed"}
      <Button variant="outline" size="sm" class="shrink-0 border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={isOffline || isAdding}
        onclick={() => onReview(server)} aria-label="Review the change of {server.name}">Review change</Button>
    {:else if server.state === "added"}
      <span class="flex h-7 shrink-0 items-center gap-1.5 px-2.5 text-chrome-dense text-(--solus-text-secondary) pointer-coarse:min-h-11">
        <Check size={16} strokeWidth={2.5} class="text-(--solus-status-complete)" aria-hidden="true" />{foundStateText(server)}
      </span>
    {:else}
      <span class="flex h-7 shrink-0 items-center px-2.5 text-chrome-dense text-(--solus-text-secondary)">{foundStateText(server)}</span>
    {/if}
  </div>
  {#if server.state === "unsupported" && server.unsupported}
    <p class="pl-11 text-chrome-dense text-(--solus-text-secondary)">{foundUnsupportedText(server.unsupported)}</p>
  {:else if server.state !== "added"}
    {#if server.projectOnly && server.transport?.kind === "stdio" && projectName}
      <p class="flex items-start gap-1.5 pl-11 text-chrome-dense text-(--solus-status-permission)">
        <TriangleAlert size={14} class="mt-0.5 shrink-0" aria-hidden="true" />{projectCommandWarning(projectName)}
      </p>
    {/if}
    {#if port}
      <p class="pl-11 text-chrome-dense text-(--solus-text-secondary)">{portIdentityText(port)}</p>
    {/if}
    {#if server.commandMissing}
      <p class="pl-11 text-chrome-dense text-(--solus-text-secondary)">This host does not have the program {server.transport?.kind === "stdio" ? server.transport.command : ""}. Install it before you start the server.</p>
    {/if}
  {/if}
</div>
