<script lang="ts">
  /** Model routing: the models Auto routes a new session's first prompt to, one
   *  per category. Lives under General beside the default model, where Auto is chosen. */
  import { untrack } from "svelte";
  import { ROUTING_CATEGORIES, ROUTING_LABELS, ROUTING_PROVIDERS, type RoutingCategory } from "@solus/contracts/model-routing";
  import { modelRoutingStore, routingModelsFor } from "./model-routing.store.svelte";
  import type { PickerSelection } from "../pickers/lib/picker-selection";
  import SessionChip from "../pickers/SessionChip.svelte";
  import { solusToolsStore } from "./solus-tools.store.svelte";
  import { getWorkspaceContext } from "../../contexts";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { Button } from "../ui/button";

  let { serverId, visible = true }: { serverId: string; visible?: boolean } = $props();
  const workspace = getWorkspaceContext();
  const state = $derived(modelRoutingStore.states.get(serverId));
  const routingModels = $derived(routingModelsFor(state?.agents ?? []));
  const routingAgents = $derived(state?.agents.filter((agent) =>
    ROUTING_PROVIDERS.some((provider) => provider === agent.id) && agent.available !== false,
  ) ?? []);
  // Jev does the routing, so without a TypeSafe key these choices do nothing.
  const keyMissing = $derived(solusToolsStore.isTypeSafeKeyMissing(serverId));
  $effect(() => {
    const targetServerId = serverId;
    return untrack(() => {
      const stopRouting = modelRoutingStore.watch(targetServerId);
      const stopTools = solusToolsStore.watch(targetServerId);
      return () => { stopRouting(); stopTools(); };
    });
  });

  const categoryHints = {
    ui: "Layout, styling, and interaction work.",
    general: "Everything else, and prompts Jev can't classify.",
    exploration: "Research and investigation with no fixed answer.",
    structured: "Clear requirements and a bounded result.",
  } satisfies Record<RoutingCategory, string>;
</script>

<SettingsSection
  label="Model routing"
  {visible}
>
  {#if state?.config}
    {@const config = state.config}
    {#if keyMissing}
      <SettingsRow
        label="TypeSafe key required"
        description="Needs a TypeSafe key. Until then, Auto uses General use."
      >
        {#snippet control()}
          <Button variant="outline" size="sm" class="text-workspace-chrome [@media(pointer:coarse)]:min-h-11" onclick={() => workspace.selectSettingsTab("tools")}>Add key</Button>
        {/snippet}
      </SettingsRow>
    {/if}
    {#each ROUTING_CATEGORIES as category (category)}
      {@const modelId = config[category]}
      {@const isInstalled = routingModels.some((model) => model.value === modelId)}
      {@const provider = routingAgents.find((agent) => agent.models.some((model) => model.id === modelId))?.id ?? routingAgents[0]?.id ?? "claude-code"}
      {@const selection = { provider, modelId, reasoningEffort: "high", fastMode: false } satisfies PickerSelection}
      <SettingsRow
        label={ROUTING_LABELS[category]}
        description={isInstalled ? categoryHints[category] : "No installed provider offers this. Auto uses General use."}
        disabled={keyMissing}
      >
        {#snippet control()}
          <SessionChip
            {selection}
            agents={routingAgents}
            modelOnly
            menuSide="bottom"
            ariaLabel={`${ROUTING_LABELS[category]} model`}
            returnFocusOnClose
            class="w-full @min-[30rem]/pane:w-56"
            disabled={state.saving || keyMissing || routingModels.length === 0}
            onSelectionChange={(next) => {
              if (next.modelId) void modelRoutingStore.save(serverId, { ...config, [category]: next.modelId });
            }}
          />
        {/snippet}
      </SettingsRow>
    {/each}
  {:else}
    <div class="flex items-center gap-3 px-4 py-3 text-workspace-chrome">
      {#if state?.error}
        <p class="min-w-0 flex-1 text-destructive" role="alert">{state.error}</p>
        <Button variant="outline" size="sm" onclick={() => modelRoutingStore.load(serverId)}>Retry</Button>
      {:else}
        <p class="text-muted-foreground" role="status">Loading models…</p>
      {/if}
    </div>
  {/if}
</SettingsSection>
{#if state?.config && state.error}
  <p class="px-4 text-workspace-chrome text-destructive" role="alert">{state.error}</p>
{/if}
