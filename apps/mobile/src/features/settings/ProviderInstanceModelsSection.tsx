import { useState } from "react";
import { TextInput, View } from "react-native";
import { MODEL_PROFILES } from "@solus/contracts/types";
import { providerDefaultModel, withProviderDefault } from "@solus/contracts/provider-model-settings";
import { AUTO_MODEL_ID } from "@solus/contracts/model-routing";
import { useApp, useListened } from "../../app/app-context";
import type { ProviderInstance } from "@solus/contracts/provider-instances";
import { changeModelPreference, instanceModelCatalog } from "@solus/contracts/provider-instance-models";
import { AppText } from "../../components/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";

export function ProviderInstanceModelsSection({ instance, onChange }: { instance: ProviderInstance; onChange: (instance: ProviderInstance) => void }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const app = useApp();
  const settings = useListened(app.personal.changes, app.personal.current);
  const catalog = instanceModelCatalog(instance, true);
  const models = catalog.models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  // The same two groups as the model picker: current models, then legacy models behind a disclosure.
  const isLegacy = (modelId: string) => catalog.modelProfiles[modelId]?.isLegacy === true;
  const legacy = models.filter((model) => isLegacy(model.id));
  // The model new sessions start with: the personal provider default, else the built-in one.
  const defaultModelId = providerDefaultModel(instance.provider, settings.defaultModels[instance.provider], catalog.modelProfiles);
  const row = (model: { id: string; label: string }) => <ModelRow key={model.id} instance={instance} model={model} isLegacy={isLegacy(model.id)} isDefault={model.id === defaultModelId} onChange={onChange} onMovedToLegacy={() => setLegacyOpen(true)} onMakeDefault={() => makeDefault(model.id)} onUseBuiltInDefault={settings.defaultModels[instance.provider] ? () => makeDefault("") : undefined} />;
  /** The personal default saves at once, as in the default model list. A hidden model returns to the picker with it. */
  function makeDefault(modelId: string) {
    if (modelId && instance.hiddenModels.includes(modelId)) onChange(changeModelPreference(instance, modelId, "visibility"));
    app.personal.set({ defaultModels: withProviderDefault(app.personal.current().defaultModels, instance.provider, modelId) });
  }
  function add() {
    if (!id.trim()) { setError("Enter the model ID that the provider accepts."); return; }
    if (catalog.modelProfiles[id.trim()]) { setError("This model ID is already in the list."); return; }
    const profile = MODEL_PROFILES[instance.provider]?.[copyFrom];
    onChange({ ...instance, customModels: [...instance.customModels, { id: id.trim(), label: label.trim() || id.trim(), reasoningLevels: [...(profile?.reasoningLevels ?? ["low", "medium", "high"])], defaultReasoningEffort: profile?.defaultReasoningEffort ?? "high", contextWindows: [...(profile?.contextWindows ?? [200000])], defaultContextWindow: profile?.defaultContextWindow ?? 200000, supportsFastMode: profile?.supportsFastMode ?? false }] });
    close();
  }
  function close() { setId(""); setLabel(""); setCopyFrom(""); setError(""); setAdding(false); }
  return <SettingsSection title="Models">
    <ModelField label="Filter models" value={query} onChange={setQuery} />
    <SettingsActionRow icon="eye" label={instance.hiddenModels.length ? "Show all models" : "Hide all models"} onPress={() => onChange({ ...instance, hiddenModels: instance.hiddenModels.length ? [] : Object.keys(MODEL_PROFILES[instance.provider] ?? {}) })} />
    {"auto".includes(query.trim().toLowerCase()) ? <SettingsChoiceRow label="Auto · Picks a model from the first prompt" selected={defaultModelId === AUTO_MODEL_ID} onPress={() => makeDefault(AUTO_MODEL_ID)} /> : null}
    {models.filter((model) => !isLegacy(model.id)).map(row)}
    {legacy.length ? <SettingsActionRow icon={legacyOpen || query ? "chevron.down" : "chevron.right"} label={`Legacy models (${legacy.length})`} onPress={() => setLegacyOpen(!legacyOpen)} /> : null}
    {legacyOpen || query ? legacy.map(row) : null}
    <SettingsActionRow icon="plus" label={adding ? "Cancel custom model" : "Add custom model"} onPress={() => (adding ? close() : setAdding(true))} />
    {adding ? <View className="gap-2">
      <ModelField label="Model ID" value={id} placeholder="Exact ID the provider accepts" onChange={setId} />
      <ModelField label="Display name" value={label} placeholder="Same as model ID" onChange={setLabel} />
      <AppText className="px-4 pt-3 text-base text-foreground">Copy reasoning levels and context window from</AppText>
      <SettingsChoiceRow label="Standard options" selected={!copyFrom} onPress={() => setCopyFrom("")} />
      {Object.entries(MODEL_PROFILES[instance.provider] ?? {}).filter(([, profile]) => !profile.isLegacy).map(([modelId, profile]) => <SettingsChoiceRow key={modelId} label={profile.label} selected={copyFrom === modelId} onPress={() => setCopyFrom(modelId)} />)}
      {error ? <AppText accessibilityRole="alert" className="px-4 text-sm text-danger-foreground">{error}</AppText> : null}
      <SettingsActionRow icon="plus" label="Add model" onPress={add} />
    </View> : null}
  </SettingsSection>;
}

function ModelRow({ instance, model, isLegacy, isDefault, onChange, onMovedToLegacy, onMakeDefault, onUseBuiltInDefault }: { instance: ProviderInstance; model: { id: string; label: string }; isLegacy: boolean; isDefault: boolean; onChange: (instance: ProviderInstance) => void; onMovedToLegacy: () => void; onMakeDefault: () => void; onUseBuiltInDefault?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const custom = instance.customModels.find((item) => item.id === model.id);
  const hidden = !custom && instance.hiddenModels.includes(model.id);
  const change = (action: 'visibility' | 'group' | 'up' | 'down') => onChange(changeModelPreference(instance, model.id, action));
  const tags = [isDefault ? "Default" : null, custom ? "Custom" : null, hidden ? "Hidden" : null].filter(Boolean).join(" · ");
  return <View className="border-t border-border">
    <SettingsActionRow icon="sparkles" label={tags ? `${model.label} · ${tags}` : model.label} onPress={() => setExpanded(!expanded)} />
    {expanded ? <>
      {!isLegacy && !isDefault ? <SettingsActionRow icon="checkmark.circle" label="Make default" onPress={onMakeDefault} /> : null}
      {isDefault && onUseBuiltInDefault ? <SettingsActionRow icon="arrow.uturn.backward" label="Use built-in default" onPress={onUseBuiltInDefault} /> : null}
      <SettingsActionRow icon={isLegacy ? "arrow.up.circle" : "archivebox"} label={isLegacy ? "Move to main models" : "Move to legacy models"} onPress={() => { if (!isLegacy) onMovedToLegacy(); change("group"); }} />
      <SettingsActionRow icon="arrow.up" label="Move up" onPress={() => change("up")} />
      <SettingsActionRow icon="arrow.down" label="Move down" onPress={() => change("down")} />
      {custom ? <>
        <ModelField label="Display name" value={custom.label} onChange={(label) => onChange({ ...instance, customModels: instance.customModels.map((item) => item.id === model.id ? { ...item, label } : item) })} />
        <ModelField label="Context window" value={String(custom.defaultContextWindow)} onChange={(value) => onChange({ ...instance, customModels: instance.customModels.map((item) => item.id === model.id ? { ...item, defaultContextWindow: Number(value), contextWindows: [Number(value)] } : item) })} />
        {custom.reasoningLevels.map((effort) => <SettingsChoiceRow key={effort} label={`${effort} reasoning`} selected={custom.defaultReasoningEffort === effort} onPress={() => onChange({ ...instance, customModels: instance.customModels.map((item) => item.id === model.id ? { ...item, defaultReasoningEffort: effort } : item) })} />)}
        {instance.provider === "codex" ? <SettingsSwitchRow label="Fast mode supported" value={custom.supportsFastMode} onValueChange={(supportsFastMode) => onChange({ ...instance, customModels: instance.customModels.map((item) => item.id === model.id ? { ...item, supportsFastMode } : item) })} /> : null}
        <SettingsActionRow icon="trash" label="Remove custom model" tone="danger" onPress={() => onChange({ ...instance, customModels: instance.customModels.filter((item) => item.id !== model.id) })} />
      </> : <SettingsSwitchRow label="Show in model picker" disabled={isDefault && !hidden} value={!hidden} onValueChange={() => change("visibility")} />}
    </> : null}
  </View>;
}
function ModelField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  return <View className="gap-2 px-4 py-3"><AppText className="text-base text-foreground">{label}</AppText><TextInput accessibilityLabel={label} value={value} placeholder={placeholder} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} className="min-h-10 rounded-lg border border-border bg-input px-3 py-2 text-base text-foreground" /></View>;
}
