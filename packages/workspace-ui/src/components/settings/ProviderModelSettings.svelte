<script lang="ts">
  import { MODEL_PROFILES, REASONING_EFFORT_LABELS, type AgentId, type ModelProfile } from "@solus/contracts/types";
  import type { ModelOptions } from "@solus/contracts/settings";
  import { providerDefaultModel, providerModelChoices, providerModelOptions } from "@solus/contracts/provider-model-settings";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsTextField from "./SettingsTextField.svelte";

  let { provider, label, description, modelProfiles }: { provider: AgentId; label: string; description?: string; modelProfiles?: Record<string, ModelProfile> } = $props();
  const settings = getSettingsContext();
  const workspace = getWorkspaceContext();
  const savedModel = $derived(settings.defaultModels[provider] ?? "");
  const modelId = $derived(providerDefaultModel(provider, savedModel, modelProfiles));
  const profiles = $derived(modelProfiles ?? MODEL_PROFILES[provider] ?? {});
  const profile = $derived(modelId ? profiles[modelId] : undefined);
  const options = $derived(providerModelOptions(provider, modelId, modelId ? settings.modelOptionsByProvider[provider]?.[modelId] : undefined, profile));
  const hasSavedOptions = $derived(!!modelId && !!settings.modelOptionsByProvider[provider]?.[modelId]);

  function setOptions(patch: Partial<ModelOptions>) {
    if (!modelId || !profile) return;
    settings.setPersonal("modelOptionsByProvider", {
      ...$state.snapshot(settings.modelOptionsByProvider),
      [provider]: { ...$state.snapshot(settings.modelOptionsByProvider[provider] ?? {}), [modelId]: { ...options, ...patch } },
    });
    workspace.config.refreshDefaultModel(provider);
  }

  function resetOptions() {
    if (!modelId) return;
    const next = { ...$state.snapshot(settings.modelOptionsByProvider[provider] ?? {}) };
    delete next[modelId];
    settings.setPersonal("modelOptionsByProvider", { ...$state.snapshot(settings.modelOptionsByProvider), [provider]: next });
    workspace.config.refreshDefaultModel(provider);
  }

  let instructionError = $state(false);

  function setInstructions(value: string) {
    if (!modelId) return;
    const next = { ...$state.snapshot(settings.modelInstructions) };
    if (value) next[modelId] = value;
    else delete next[modelId];
    instructionError = !settings.setPersonal("modelInstructions", next);
  }
</script>

<SettingsSection {label} {description}>
  <SettingsRow label="Default model" description="Model for new sessions with this provider. Existing sessions keep their model.">
    {#snippet control()}
      <SettingsSelect options={providerModelChoices(provider, savedModel, profiles)} value={savedModel} onSelect={(value) => workspace.config.setDefaultModel(provider, value)} ariaLabel="{label} default model" />
    {/snippet}
  </SettingsRow>
  {#if savedModel && savedModel !== "auto" && !profiles[savedModel]}
    <SettingsRow label="Saved model unavailable" description="Your choice stays saved. New sessions use the built-in default until you choose an available model." />
  {/if}
  {#if profile && modelId}
    <SettingsRow label="Reasoning" description="Reasoning level for this model in new sessions.">
      {#snippet control()}
        <SettingsSelect options={profile.reasoningLevels.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] }))} value={options.reasoningEffort} onSelect={(value) => setOptions({ reasoningEffort: value })} ariaLabel="{label} default reasoning" />
      {/snippet}
    </SettingsRow>
    <SettingsRow label="Context window" description="Maximum context for this model in new sessions.">
      {#snippet control()}
        <SettingsSelect options={[{ value: "", label: "Model default" }, ...profile.contextWindows.map((value) => ({ value: String(value), label: `${value.toLocaleString()} tokens` }))]} value={options.contextWindow === null ? "" : String(options.contextWindow)} onSelect={(value) => setOptions({ contextWindow: value ? Number(value) : null })} ariaLabel="{label} default context window" />
      {/snippet}
    </SettingsRow>
    {#if profile.supportsFastMode}
      <SettingsRow label="Fast mode" description="Use the provider's fast service for this model. Provider charges can be higher.">
        {#snippet control()}
          <Switch checked={options.fastMode} onCheckedChange={(value) => setOptions({ fastMode: value })} aria-label="{label} default fast mode" />
        {/snippet}
      </SettingsRow>
    {/if}
    <SettingsRow label="Model instructions" description="Added whenever this model runs, including existing sessions.">
      {#snippet body()}
        <SettingsTextField label="{label} model instructions" value={settings.modelInstructions[modelId] ?? ""} onValueChange={setInstructions} placeholder="Instructions for this model…" />
        {#if instructionError}<p role="alert" class="mt-2 text-sm text-destructive">These instructions could not be saved. The settings size limit was reached.</p>{/if}
      {/snippet}
    </SettingsRow>
    <SettingsRow label="Reset model options" description="Use this model's built-in reasoning, context window, and speed.">
      {#snippet control()}
        <Button variant="outline" size="sm" disabled={!hasSavedOptions} onclick={resetOptions}>Reset options</Button>
      {/snippet}
    </SettingsRow>
  {:else if modelId === "auto"}
    <SettingsRow label="Automatic model selection" description="Auto selects a model from the first prompt and uses routing options. Configure Auto in Sessions. A TypeSafe key is required on the run host." />
  {/if}
</SettingsSection>
