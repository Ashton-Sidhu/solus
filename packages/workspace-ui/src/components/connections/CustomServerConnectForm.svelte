<script lang="ts">
  /**
   * The connect card's row for a server that is not in the catalog
   * (docs/integrations.md): one field, as in Settings, that takes an address
   * or the JSON of a setup page. An address is added the same way the MCP page
   * adds it, with the static OAuth client or the headers the JSON names. A
   * command runs as code on the host, so the card hands it to Settings, where
   * an administrator adds it with its values. An agent can prefill the field,
   * but only this form adds it. After that the row is the server's sign-in.
   */
  import { untrack } from "svelte";
  import { SetupHandoff } from "@solus/contracts/integrations/setup-handoff";
  import { INTEGRATION_OAUTH_LOOPBACK_URL } from "@solus/contracts/integrations/oauth-callback";
  import { readServerSource, urlSourceAdd, type ServerSource } from "@solus/contracts/integrations/server-source";
  import { connectRequestStore, type CustomServerConnectRequest } from "../../contexts/connections/connect-request.store.svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { Input } from "../ui/input";
  import MarkdownAlert from "../ui/MarkdownAlert.svelte";
  import McpSourceKindTag from "../settings/McpSourceKindTag.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { mcpStore } from "../../contexts/mcp";
  import { customUrlProblem, urlHost } from "../settings/lib/integration-labels";
  import { McpInstalls } from "../settings/lib/mcp-installs.svelte";
  import { mcpPageRequest } from "../settings/lib/mcp-page-request.svelte";
  import { settingsHost } from "../settings/lib/settings-host.svelte";

  interface Props {
    request: CustomServerConnectRequest;
    onhandoff: (prompt: string) => void;
  }

  let { request, onhandoff }: Props = $props();

  const workspace = getWorkspaceContext();
  const serverId = $derived(request.serverId);
  // The row mounts one form per request, so one run serves it for its whole life.
  const adds = new McpInstalls(untrack(() => request.serverId));
  let field = $state(untrack(() => request.url ?? ""));
  /** The JSON the person pasted, while the field still shows what it named: Settings reads it again for a command. */
  let pasted = $state<{ text: string; source: ServerSource } | null>(null);

  const source = $derived(pasted?.source ?? readServerSource(field));
  const url = $derived(source.kind === "url" ? source.url : "");
  const isCommand = $derived(source.kind === "command");
  const name = $derived(request.name ?? (source.kind === "url" ? source.name : undefined) ?? urlHost(url));
  const problem = $derived(source.kind === "invalid" ? source.reason : url ? customUrlProblem(url) : null);
  const install = $derived(adds.installs.get(url));
  const isAdding = $derived(!!install && install.kind !== "failed");
  const failure = $derived(install?.kind === "failed" ? install : null);
  const hostState = $derived(mcpStore.integrations.states.get(serverId));
  const isOffline = $derived(!!hostState?.isDisconnected);
  const error = $derived(problem ?? failure?.message ?? null);
  const setupHandoff = $derived(
    failure?.setupNeed
      ? new SetupHandoff(failure.setupNeed, {
          name,
          url,
          callbackUrl: failure.setupNeed === "oauth-client" ? INTEGRATION_OAUTH_LOOPBACK_URL : undefined,
        })
      : null,
  );

  /** Pasted JSON shows as the address or the line it names; typing over it forgets it. */
  function onInput(text: string) {
    const read = readServerSource(text);
    const isConfig = /^\s*[{"]/.test(text) && (read.kind === "url" || read.kind === "command");
    pasted = isConfig ? { text, source: read } : null;
    field = isConfig && read.kind === "url" ? read.url : isConfig && read.kind === "command" ? read.line : text;
  }

  /** A command is added in Settings: the add dialog opens on this host with the field filled. */
  function openInSettings() {
    settingsHost.serverId = serverId;
    mcpPageRequest.askAddServer(pasted?.text ?? field);
    workspace.showSettings("mcp", "click");
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (isCommand) return openInSettings();
    if (source.kind !== "url" || !url || problem || isAdding) return;
    const installed = hostState?.integrations?.find((integration) => integration.url === url);
    const add = urlSourceAdd(source);
    const integration = installed ?? (await adds.install(name, url, add.auth));
    if (!integration) return;
    // A failed save leaves the values flow open with the reason, in the row's sign-in.
    if (!installed && add.values.length > 0) await mcpStore.integrations.submitValues(serverId, integration.id, add.values);
    connectRequestStore.customServerAdded(request, integration);
  }
</script>

{#snippet commandNote()}
  <p class="m-0 text-pretty">A command runs as code on this host, so it is added in Settings, where you give its values.</p>
{/snippet}

{#snippet configNote()}
  <p class="m-0 text-pretty">Filled in from the pasted config.{#if source.kind === "url" && source.clientId} Its OAuth client ID goes with the add.{/if}</p>
{/snippet}

<form class="flex flex-col gap-2" onsubmit={submit}>
  <!-- The step's title says what to enter; the label names the field for a screen reader. -->
  <label for="custom-server-address-{request.sessionId}" class="sr-only">URL, command, or config</label>
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative min-w-0 flex-1">
      <Input
        id="custom-server-address-{request.sessionId}"
        value={field}
        oninput={(event) => onInput(event.currentTarget.value)}
        class="h-8 min-w-0 text-xs {isCommand ? 'font-mono' : ''} {source.kind === 'url' || isCommand ? 'pr-28' : ''}"
        placeholder="URL, command, or config"
        autocomplete="off"
        spellcheck={false}
        dictation={false}
        disabled={isOffline || isAdding}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `custom-server-error-${request.sessionId}` : undefined}
      />
      {#if source.kind === "url" || isCommand}<McpSourceKindTag kind={isCommand ? "command" : "url"} />{/if}
    </div>
    {#if setupHandoff}
      <TranscriptCardAction kind="ghost" onclick={() => onhandoff(setupHandoff.prompt)}>Set up with an agent</TranscriptCardAction>
    {/if}
    <TranscriptCardAction kind="filled" type="submit" disabled={isOffline || isAdding || source.kind === "empty" || !!problem}>
      {isAdding ? "Adding…" : isCommand ? "Open in Settings" : "Add"}
    </TranscriptCardAction>
  </div>
  {#if error}
    <p id="custom-server-error-{request.sessionId}" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{error}</p>
  {/if}
  {#if isCommand}
    <MarkdownAlert alertType="note" content={commandNote} />
  {:else if pasted}
    <MarkdownAlert alertType="note" content={configNote} />
  {/if}
</form>
