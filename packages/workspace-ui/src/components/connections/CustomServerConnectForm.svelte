<script lang="ts">
  /**
   * The connect card's row for a server that is not in the catalog
   * (docs/integrations.md): the person enters its address and adds it the same
   * way the MCP page does. An agent can prefill the address, but only this
   * form adds it. After that the row is the server's sign-in.
   */
  import { untrack } from "svelte";
  import { SetupHandoff } from "@solus/contracts/integrations/setup-handoff";
  import { connectRequestStore, type CustomServerConnectRequest } from "../../contexts/connections/connect-request.store.svelte";
  import { Input } from "../ui/input";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { integrationsStore } from "../settings/integrations.store.svelte";
  import { customUrlProblem, urlHost } from "../settings/lib/integration-labels";
  import { McpInstalls } from "../settings/lib/mcp-installs.svelte";

  interface Props {
    request: CustomServerConnectRequest;
    onhandoff: (prompt: string) => void;
  }

  let { request, onhandoff }: Props = $props();

  const serverId = $derived(request.serverId);
  // The row mounts one form per request, so one run serves it for its whole life.
  const adds = new McpInstalls(untrack(() => request.serverId));
  let address = $state(untrack(() => request.url ?? ""));

  const url = $derived(address.trim());
  const name = $derived(request.name ?? urlHost(url));
  const problem = $derived(url ? customUrlProblem(url) : null);
  const install = $derived(adds.installs.get(url));
  const isAdding = $derived(!!install && install.kind !== "failed");
  const failure = $derived(install?.kind === "failed" ? install : null);
  const hostState = $derived(integrationsStore.states.get(serverId));
  const isOffline = $derived(!!hostState?.isDisconnected);
  const error = $derived(problem ?? failure?.message ?? null);
  const setupHandoff = $derived(
    failure?.setupNeed
      ? new SetupHandoff(failure.setupNeed, {
          name,
          url,
          callbackUrl: failure.setupNeed === "oauth-client" ? integrationsStore.oauthRedirectUrl(serverId) : undefined,
        })
      : null,
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!url || problem || isAdding) return;
    const installed = hostState?.integrations?.find((integration) => integration.url === url);
    const integration = installed ?? (await adds.install(name, url));
    if (integration) connectRequestStore.customServerAdded(request, integration);
  }
</script>

<form class="flex flex-col gap-1.5" onsubmit={submit}>
  <label for="custom-server-address-{request.sessionId}" class="text-workspace-chrome font-medium text-foreground">Server address</label>
  <div class="flex flex-wrap items-center gap-2">
    <Input
      id="custom-server-address-{request.sessionId}"
      bind:value={address}
      class="h-8 min-w-0 flex-1 text-workspace-chrome"
      placeholder="http://localhost:8000/mcp"
      autocomplete="off"
      spellcheck={false}
      dictation={false}
      disabled={isOffline || isAdding}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `custom-server-error-${request.sessionId}` : undefined}
    />
    {#if setupHandoff}
      <TranscriptCardAction kind="ghost" onclick={() => onhandoff(setupHandoff.prompt)}>Set up with an agent</TranscriptCardAction>
    {/if}
    <TranscriptCardAction kind="filled" type="submit" disabled={isOffline || isAdding || !url || !!problem}>{isAdding ? "Adding…" : "Add"}</TranscriptCardAction>
  </div>
  {#if error}
    <p id="custom-server-error-{request.sessionId}" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{error}</p>
  {/if}
</form>
