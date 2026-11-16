<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { MODEL_PROFILES, REASONING_EFFORT_LABELS, type AgentId, type ModelProfile } from "@solus/contracts/types";
  import type { ModelOptions } from "@solus/contracts/settings";
  import { providerDefaultModel, providerModelOptions } from "@solus/contracts/provider-model-settings";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { managedSetting } from "./policy/managed-setting.svelte";
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
  {#if savedModel && savedModel !== "auto" && !profiles[savedModel]}
    <SettingsRow {...settingsDefinitions["providers.saved-model-unavailable"]} />
  {/if}
  {#if profile && modelId}
    <SettingsRow {...settingsDefinitions["providers.reasoning"]}>
      {#snippet control()}
        <SettingsSelect options={profile.reasoningLevels.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] }))} value={options.reasoningEffort} onSelect={(value) => setOptions({ reasoningEffort: value })} ariaLabel="{label} default reasoning" />
      {/snippet}
    </SettingsRow>
    <SettingsRow {...settingsDefinitions["providers.context-window"]}>
      {#snippet control()}
        <SettingsSelect options={[{ value: "", label: "Model default" }, ...profile.contextWindows.map((value) => ({ value: String(value), label: `${value.toLocaleString()} tokens` }))]} value={options.contextWindow === null ? "" : String(options.contextWindow)} onSelect={(value) => setOptions({ contextWindow: value ? Number(value) : null })} ariaLabel="{label} default context window" />
      {/snippet}
    </SettingsRow>
    {#if profile.supportsFastMode}
      <SettingsRow {...settingsDefinitions["providers.fast-mode"]}>
        {#snippet control()}
          <Switch checked={options.fastMode} onCheckedChange={(value) => setOptions({ fastMode: value })} aria-label="{label} default fast mode" />
        {/snippet}
      </SettingsRow>
    {/if}
    <SettingsRow {...settingsDefinitions["providers.model-instructions"]} managed={managedSetting("modelInstructions")} >
      {#snippet body()}
        <SettingsTextField label="{label} model instructions" value={settings.modelInstructions[modelId] ?? ""} onValueChange={setInstructions} placeholder="Run the tests before you finish. Keep each change small and explain the risk." class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-font-size:var(--text-workspace-chrome)] [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400]" />
        {#if instructionError}<p role="alert" class="mt-2 text-sm text-destructive">These instructions could not be saved. The settings size limit was reached.</p>{/if}
      {/snippet}
    </SettingsRow>
    <SettingsRow {...settingsDefinitions["providers.reset-model-options"]}>
      {#snippet control()}
        <Button variant="outline" size="sm" disabled={!hasSavedOptions} onclick={resetOptions}>Reset options</Button>
      {/snippet}
    </SettingsRow>
  {:else if modelId === "auto"}
    <SettingsRow {...settingsDefinitions["providers.automatic-model-selection"]} />
  {/if}
</SettingsSection>
