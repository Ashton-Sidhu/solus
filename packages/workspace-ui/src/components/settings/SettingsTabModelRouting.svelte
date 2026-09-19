<script lang="ts">
  import { untrack } from "svelte";
  import { DEFAULT_MODEL_ROUTING, ROUTING_CATEGORIES, ROUTING_LABELS, ROUTING_PROVIDERS } from "@solus/contracts/model-routing";
  import { ChevronDown } from "@lucide/svelte";
  import { modelRoutingStore } from "./model-routing.store.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  let { serverId, searchQuery = "" }: { serverId: string; searchQuery?: string } = $props();
  const state = $derived(modelRoutingStore.states.get(serverId));
  $effect(() => {
    const targetServerId = serverId;
    return untrack(() => modelRoutingStore.watch(targetServerId));
  });
</script>

<p class="text-workspace-chrome text-muted-foreground">
  Select Auto in a new session to send its first prompt to Jev. The selected model stays in use for that session.
  If Jev is unavailable or takes more than three seconds, Auto uses General use. Add your TypeSafe key in Tools.
</p>

{#if state?.error}
  <div class="flex items-center gap-3 text-workspace-chrome" role="alert">
    <p class="min-w-0 flex-1 text-destructive">{state.error}</p>
    <Button variant="outline" size="sm" onclick={() => modelRoutingStore.load(serverId)}>Retry</Button>
  </div>
{/if}
{#if !state || state.loading}
  <p class="text-workspace-chrome text-muted-foreground" role="status">Loading model routing…</p>
{:else if state.config}
  {@const config = state.config}
  {#each ROUTING_CATEGORIES as category}
    <SettingsSection label={ROUTING_LABELS[category]} visible={!searchQuery || `${ROUTING_LABELS[category]} model routing auto provider fallback`.toLowerCase().includes(searchQuery.toLowerCase())}>
      <SettingsRow label="Preferred provider" description="Use the other provider if this provider is unavailable.">
        {#snippet control()}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger disabled={state.saving} class="flex items-center gap-2 rounded-md px-2 py-1.5 text-workspace-chrome hover:bg-muted" aria-label={`${ROUTING_LABELS[category]} preferred provider`}>
              {config[category].preferredProvider === 'codex' ? 'Codex' : 'Claude'}
              <ChevronDown size={12} class="shrink-0" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {#each ROUTING_PROVIDERS as provider}
                <DropdownMenu.Item onSelect={() => modelRoutingStore.save(serverId, { ...config, [category]: { ...config[category], preferredProvider: provider } })}>
                  {provider === 'codex' ? 'Codex' : 'Claude'}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/snippet}
      </SettingsRow>
      {#each ROUTING_PROVIDERS as provider}
        {@const agent = state.agents.find(agent => agent.id === provider)}
        {@const modelId = config[category][provider]}
        <SettingsRow label={provider === 'codex' ? 'Codex model' : 'Claude model'} description={agent?.available === false ? 'Provider unavailable on this host.' : undefined}>
          {#snippet control()}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger disabled={state.saving || !agent?.models.length} class="flex max-w-44 items-center gap-2 rounded-md px-2 py-1.5 text-workspace-chrome hover:bg-muted" aria-label={`${ROUTING_LABELS[category]} ${provider} model`}>
                <span class="truncate">{agent?.models.find(model => model.id === modelId)?.label ?? modelId}</span>
                <ChevronDown size={12} class="shrink-0" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.RadioGroup value={modelId}>
                  {#each agent?.models ?? [] as model}
                    <DropdownMenu.RadioItem value={model.id} onSelect={() => modelRoutingStore.save(serverId, { ...config, [category]: { ...config[category], [provider]: model.id } })}>{model.label}</DropdownMenu.RadioItem>
                  {/each}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/snippet}
        </SettingsRow>
      {/each}
    </SettingsSection>
  {/each}
  <div>
    <Button variant="outline" size="sm" disabled={state.saving} onclick={() => modelRoutingStore.save(serverId, DEFAULT_MODEL_ROUTING)}>Restore defaults</Button>
  </div>
{/if}
