<script lang="ts">
  /**
   * Settings → Agent profile → MCP servers: each server's record (name,
   * address, how it signs in), never a credential. Adding probes the address
   * through a host this client talks to, so the record carries the auth the
   * server asks for. A server can be removed, or turned off on every host and
   * kept in the profile.
   */
  import { tick } from "svelte";
  import { LoaderCircle, Plus } from "@lucide/svelte";
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import { integrationsStore } from "../integrations.store.svelte";
  import { customUrlProblem, probeRefusal, urlHost } from "../lib/integration-labels";
  import { authKindLabel, entriesWithDisabled, integrationEntryOf, type AgentProfileSections } from "./lib/agent-profile-entries";

  interface Props {
    integrations: AgentProfileSections["integrations"];
    /** The host that probes an address for this client; null with no host connected. */
    probeHostId: string | null;
  }

  let { integrations, probeHostId }: Props = $props();

  let isAdding = $state(false);
  let url = $state("");
  let name = $state("");
  let checking = $state(false);
  let problem = $state<string | null>(null);
  let urlEl = $state<HTMLInputElement | null>(null);
  const urlProblem = $derived(url.trim() ? customUrlProblem(url.trim()) : null);

  async function openAdd() {
    isAdding = true;
    await tick();
    urlEl?.focus();
  }

  function closeAdd() {
    isAdding = false;
    url = "";
    name = "";
    problem = null;
    requestInputFocus();
  }

  async function add() {
    const address = url.trim();
    const hostId = probeHostId;
    if (!hostId || urlProblem || checking) return;
    checking = true;
    problem = null;
    try {
      const attempt = await integrationsStore.probe(hostId, address);
      if ("error" in attempt) {
        problem = attempt.error;
        return;
      }
      const refusal = probeRefusal(attempt.result);
      if (refusal || attempt.result.outcome === "undetermined") {
        problem = refusal;
        return;
      }
      const entry = integrationEntryOf(name.trim() || urlHost(address), address, attempt.result.auth);
      if (!entry) {
        problem = "This name or address does not fit a profile entry.";
        return;
      }
      agentProfileLocalStore.setEntry(entry);
      closeAdd();
    } finally {
      checking = false;
    }
  }

  function remove(key: AgentProfileKey) {
    agentProfileLocalStore.removeKey(key);
    requestInputFocus();
  }

  function setDisabled(key: AgentProfileKey, disabled: boolean) {
    agentProfileLocalStore.setEntry(...entriesWithDisabled(agentProfileLocalStore.storedEntries, [key], disabled));
    requestInputFocus();
  }
</script>

<SettingsSection
  label={integrations.length > 0 ? `MCP servers · ${integrations.length}` : "MCP servers"}
  description="Added for you on every host the profile reaches. Sign-ins stay out of the profile; each host asks once."
>
  {#snippet action()}
    {#if isAdding}
      <Button variant="ghost" size="sm" class="[@media(pointer:coarse)]:min-h-11" onclick={closeAdd}>Cancel</Button>
    {:else}
      <Button variant="outline" size="sm" class="[@media(pointer:coarse)]:min-h-11" onclick={() => void openAdd()}><Plus size={14} />Add a server</Button>
    {/if}
  {/snippet}
  {#if isAdding}
    <form class="flex flex-col gap-2 px-4 py-3" onsubmit={(event) => { event.preventDefault(); void add(); }} aria-label="Add an MCP server">
      <Input
        bind:ref={urlEl}
        bind:value={url}
        placeholder="https://mcp.example.com/mcp"
        aria-label="Server address"
        autocomplete="off"
        spellcheck={false}
        class="text-workspace-chrome"
        onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeAdd(); } }}
      />
      <Input bind:value={name} placeholder={url.trim() ? urlHost(url.trim()) : "Name"} aria-label="Server name" autocomplete="off" class="text-workspace-chrome" />
      {#if !probeHostId}
        <p class="text-chrome-dense text-muted-foreground">Connect a host to check an address.</p>
      {:else if urlProblem}
        <p class="text-chrome-dense text-(--solus-status-error)">{urlProblem}</p>
      {/if}
      {#if problem}
        <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{problem}</p>
      {/if}
      <div class="flex justify-end">
        <Button type="submit" size="sm" disabled={!probeHostId || !url.trim() || !!urlProblem || checking}>
          {#if checking}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Checking…{:else}Add{/if}
        </Button>
      </div>
    </form>
  {/if}
  {#if integrations.length === 0 && !isAdding}
    <p class="p-8 text-center text-workspace-chrome text-muted-foreground">No MCP servers in your profile yet.</p>
  {/if}
  {#each integrations as integration (integration.slug)}
    <SettingsRow label={integration.name} description="{urlHost(integration.url)} · {authKindLabel(integration.auth)}" testId="agent-profile-server">
      {#snippet labelExtra()}
        {#if integration.disabled}<span class="ml-2 text-chrome-dense text-muted-foreground">Off on every host</span>{/if}
      {/snippet}
      {#snippet control()}
        <span class="flex gap-1.5">
          <Button variant="ghost" size="sm" onclick={() => setDisabled(agentProfileKeyOf(integration), !integration.disabled)} aria-label="{integration.disabled ? 'Enable' : 'Disable'} {integration.name}">{integration.disabled ? "Enable" : "Disable"}</Button>
          <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(integration))} aria-label="Remove {integration.name}">Remove</Button>
        </span>
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>
