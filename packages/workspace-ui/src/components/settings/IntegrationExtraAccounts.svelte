<script lang="ts">
  /**
   * The caller's accounts after the first on one integration
   * (docs/plans/mcp-integrations.md §13.3), and "Add another account". The
   * first account is the connect form above this. An added account lives on
   * this host; tools that read span every account, and tools that write name one.
   */
  import { ExternalLink, LoaderCircle, Plus } from "@lucide/svelte";
  import type { Integration } from "@solus/contracts/integration-types";
  import { IntegrationSignIn } from "@solus/contracts/integrations/integration-sign-in";
  import { Button } from "../ui/button";
  import { integrationsStore } from "./integrations.store.svelte";
  import { connectionStatusText } from "./lib/integration-labels";

  interface Props {
    serverId: string;
    integration: Integration;
  }

  let { serverId, integration }: Props = $props();

  const accounts = $derived(integrationsStore.accounts.accounts(serverId, integration.id));
  const adding = $derived(integrationsStore.accounts.addState(serverId, integration.id));
  const first = $derived(integrationsStore.connection(serverId, integration.id));
  const isOffline = $derived(!!integrationsStore.states.get(serverId)?.isDisconnected);
  /** One more account signs in only beside a connected first one, and only with OAuth. */
  const canAdd = $derived(new IntegrationSignIn(integration).acceptsAnotherAccount && first?.status === "connected");
</script>

{#if accounts.length > 0 || canAdd}
  <div class="flex flex-col gap-2" data-testid="integration-extra-accounts">
    {#each accounts as account (account.accountId)}
      {@const status = connectionStatusText(account)}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="min-w-0 flex-1 truncate text-workspace-chrome {account.status === 'connected' ? 'text-foreground' : 'text-(--solus-status-error)'}" title={status.text}>
          {account.label ?? "Another account"}<span class="text-muted-foreground"> · {account.status === "connected" ? "Connected" : status.text}</span>
        </p>
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground hover:text-destructive pointer-coarse:min-h-11" disabled={isOffline}
          aria-label="Disconnect {account.label ?? 'this account'}" onclick={() => integrationsStore.accounts.disconnect(serverId, integration.id, account.accountId)}>Disconnect</Button>
      </div>
    {/each}
    {#if adding?.url}
      <div class="flex flex-wrap items-center gap-2">
        <p role="status" class="flex min-w-0 flex-1 items-center gap-2 text-workspace-chrome text-muted-foreground">
          <LoaderCircle size={14} class="shrink-0 animate-spin motion-reduce:animate-none" />Finish signing in to the other account in your browser
        </p>
        <Button variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => adding.url && integrationsStore.openInBrowser(adding.url)}>Reopen<ExternalLink size={14} /></Button>
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={() => integrationsStore.accounts.cancelAdd(serverId, integration.id)}>Cancel</Button>
      </div>
    {:else if canAdd}
      <div>
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" disabled={isOffline || (adding !== null && !adding.error)}
          onclick={() => integrationsStore.accounts.add(serverId, integration.id, (url) => integrationsStore.openInBrowser(url))}>
          <Plus size={14} />Add another account
        </Button>
      </div>
    {/if}
    {#if adding?.error}
      <p role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{adding.error}</p>
    {/if}
  </div>
{/if}
