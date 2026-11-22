<script lang="ts">
  /**
   * A server's OAuth scopes, or a `headers` server's header names, in its row
   * (docs/plans/mcp-add-server.md): the words, and Edit to change them in
   * place. Scopes can go back to the ones the server names. New header names
   * remove every person's values for the old ones, so the form says so.
   */
  import { tick } from "svelte";
  import { parseHeaderNames, parseScopes } from "@solus/contracts/integrations/auth-choice";
  import type { Integration } from "@solus/contracts/integration-types";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { mcpStore } from "../../contexts/mcp";

  interface Props {
    serverId: string;
    integration: Integration;
    kind: "scopes" | "headers";
    canEdit: boolean;
  }

  let { serverId, integration, kind, canEdit }: Props = $props();

  let isEditing = $state(false);
  let draft = $state("");
  let error = $state("");
  let rootEl = $state<HTMLDivElement | null>(null);

  const hostState = $derived(mcpStore.integrations.states.get(serverId));
  const isBusy = $derived(!!hostState?.saving);
  const isOffline = $derived(!!hostState?.isDisconnected);
  const words = $derived(integration.auth.kind === "oauth" && kind === "scopes" ? integration.auth.scopes ?? [] : integration.auth.kind === "headers" ? integration.auth.names : []);
  const fieldId = $derived(`mcp-${kind}-${integration.id}`);

  async function startEdit() {
    draft = words.join(" ");
    error = "";
    isEditing = true;
    await tick();
    rootEl?.querySelector<HTMLInputElement>("input")?.focus();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (kind === "scopes") {
      const parsed = parseScopes(draft);
      if (!parsed.ok) { error = parsed.reason; return; }
      await write({ id: integration.id, scopes: parsed.scopes });
    } else {
      const parsed = parseHeaderNames(draft);
      if (!parsed.ok) { error = parsed.reason; return; }
      await write({ id: integration.id, headerNames: parsed.names });
    }
  }

  async function write(request: { id: string; scopes: string[] | null } | { id: string; headerNames: string[] }) {
    error = "";
    if (await mcpStore.integrations.update(serverId, request)) { isEditing = false; return; }
    error = hostState?.writeError || "The host did not save the change.";
    mcpStore.integrations.clearWriteError(serverId);
  }
</script>

<div bind:this={rootEl} class="flex min-w-0 flex-col gap-2">
  {#if isEditing}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <form class="flex flex-col gap-2" onsubmit={save} onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); isEditing = false; } }}>
      <Input id={fieldId} bind:value={draft} oninput={() => (error = "")} placeholder={kind === "scopes" ? "read write" : "X-API-Key X-Tenant"} autocomplete="off" spellcheck={false} dictation={false}
        aria-label={kind === "scopes" ? `Scopes of ${integration.name}` : `Header names of ${integration.name}`} aria-invalid={error ? true : undefined} aria-describedby="{fieldId}-hint"
        disabled={isBusy || isOffline} class="h-8 min-w-0 font-mono text-workspace-chrome" />
      <p id="{fieldId}-hint" role={error ? "alert" : undefined} class="break-words text-chrome-dense {error ? 'text-(--solus-status-error)' : 'text-(--solus-text-secondary)'}">
        {error || (kind === "scopes" ? "Separated by spaces. The next sign-in asks for them." : "Separated by spaces. New names remove the values saved for the old ones.")}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" disabled={isBusy || isOffline}>{isBusy ? "Saving…" : "Save"}</Button>
        {#if kind === "scopes" && words.length > 0}
          <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" disabled={isBusy || isOffline}
            onclick={() => write({ id: integration.id, scopes: null })}>Use the server’s scopes</Button>
        {/if}
        <Button variant="ghost" size="sm" class="text-workspace-chrome text-muted-foreground pointer-coarse:min-h-11" onclick={() => { isEditing = false; }}>Cancel</Button>
      </div>
    </form>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {#each words as word (word)}
          <span class="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-chrome-dense text-foreground">{word}</span>
        {:else}
          <span class="text-workspace-chrome text-(--solus-text-secondary)">The ones the server names</span>
        {/each}
      </div>
      <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome pointer-coarse:min-h-11" disabled={!canEdit || isBusy || isOffline}
        aria-label={kind === "scopes" ? `Edit the scopes of ${integration.name}` : `Edit the header names of ${integration.name}`} onclick={startEdit}>Edit</Button>
    </div>
  {/if}
</div>
