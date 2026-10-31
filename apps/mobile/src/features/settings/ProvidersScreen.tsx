import { useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { instanceModelCatalog } from "@solus/contracts/provider-instance-models";
import { useProviderInstances } from "./use-provider-instances";
import { MODEL_PROFILES, REASONING_EFFORT_LABELS } from "@solus/contracts/types";
import type { ModelOptions } from "@solus/contracts/settings";
import { PROVIDERS, providerDefaultModel, providerModelChoices, providerModelOptions, withProviderDefault } from "@solus/contracts/provider-model-settings";
import { useApp, useListened } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";

export function ProvidersScreen({ navigation }: ScreenProps<"Providers">) {
  const app = useApp();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const defaults = useListened(app.personal.changes, () => app.personal.current().defaultModels);
  return (
    <SettingsScreen title="Providers">
      <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-5 py-4">
        <SettingsSection title="Model defaults">
          {PROVIDERS.map((provider) => (
            <SettingsRow key={provider.id} icon="sparkles" label={provider.label}
              value={providerModelChoices(provider.id, defaults[provider.id]).find((model) => model.value === (defaults[provider.id] ?? ""))?.label}
              onPress={() => navigation.navigate("ProviderSettings", { provider: provider.id })} />
          ))}
        </SettingsSection>
        <SettingsNote>These preferences are yours. They follow your account when settings sync is on. Existing sessions keep their model.</SettingsNote>
        <SettingsSection title="Private provider instances">
          {hosts.map((host) => <SettingsRow key={host.id} icon="desktopcomputer" label={host.label} value="Runtime paths, arguments, and environment" onPress={() => navigation.navigate("ProviderInstances", { hostId: host.id })} />)}
        </SettingsSection>
        <SettingsSection title="Provider setup">
          <SettingsRow icon="desktopcomputer" label="Hosts" value="Installation and sign-in on each host" onPress={() => navigation.navigate("Hosts")} />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function ProviderSettingsScreen({ route }: ScreenProps<"ProviderSettings">) {
  const { provider, hostId, instanceId } = route.params;
  const privateInstances = useProviderInstances(hostId);
  const privateInstance = privateInstances.view.snapshot?.instances.find((instance) => instance.id === instanceId);
  const profiles = privateInstance ? instanceModelCatalog(privateInstance).modelProfiles : MODEL_PROFILES[provider] ?? {};
  const app = useApp();
  const insets = useSafeAreaInsets();
  const settings = useListened(app.personal.changes, app.personal.current);
  const savedModel = settings.defaultModels[provider] ?? "";
  const modelId = providerDefaultModel(provider, savedModel, profiles);
  const label = PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
  const profile = modelId ? profiles[modelId] : undefined;
  const savedOptions = modelId ? settings.modelOptionsByProvider[provider]?.[modelId] : undefined;
  const options = providerModelOptions(provider, modelId, savedOptions, profile);
  function setOptions(patch: Partial<ModelOptions>) {
    if (!modelId || !profile) return;
    // Read at the action so a sync cannot overwrite another model's choice.
    const current = app.personal.current();
    app.personal.saveModelOptions(provider, modelId, {
      ...providerModelOptions(provider, modelId, current.modelOptionsByProvider[provider]?.[modelId], profile), ...patch,
    });
  }
  function resetOptions() {
    if (!modelId) return;
    const current = app.personal.current();
    const next = { ...current.modelOptionsByProvider[provider] };
    delete next[modelId];
    app.personal.set({ modelOptionsByProvider: { ...current.modelOptionsByProvider, [provider]: next } });
  }
  return (
    <SettingsScreen title={label}>
      <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}>
        <SettingsSection title="Default model">
          {providerModelChoices(provider, savedModel, profiles).map((model, index) => (
            <SettingsChoiceRow key={model.value} separated={index > 0} label={model.label} selected={savedModel === model.value}
              onPress={() => app.personal.set({ defaultModels: withProviderDefault(app.personal.current().defaultModels, provider, model.value) })} />
          ))}
        </SettingsSection>
        {savedModel && savedModel !== "auto" && !profiles[savedModel] ? (
          <SettingsNote>Your choice stays saved. New sessions use the built-in default until you choose an available model.</SettingsNote>
        ) : null}
        {profile && modelId ? <>
          <SettingsSection title="Reasoning">
            {profile.reasoningLevels.map((effort, index) => (
              <SettingsChoiceRow key={effort} separated={index > 0} label={REASONING_EFFORT_LABELS[effort]} selected={options.reasoningEffort === effort} onPress={() => setOptions({ reasoningEffort: effort })} />
            ))}
          </SettingsSection>
          <SettingsSection title="Context window">
            <SettingsChoiceRow label="Model default" selected={options.contextWindow === null} onPress={() => setOptions({ contextWindow: null })} />
            {profile.contextWindows.map((window) => (
              <SettingsChoiceRow key={window} separated label={`${window.toLocaleString()} tokens`} selected={options.contextWindow === window} onPress={() => setOptions({ contextWindow: window })} />
            ))}
          </SettingsSection>
          {profile.supportsFastMode ? <View className="gap-3">
            <SettingsSection title="Speed"><SettingsSwitchRow label="Fast mode" value={options.fastMode} onValueChange={(fastMode) => setOptions({ fastMode })} /></SettingsSection>
            <SettingsNote>Use the provider's fast service for this model. Provider charges can be higher.</SettingsNote>
          </View> : null}
          <ModelInstructions key={modelId} modelId={modelId} value={settings.modelInstructions[modelId] ?? ""} />
          <SettingsSection title="Reset">
            <SettingsActionRow icon="arrow.clockwise" label="Reset model options" disabled={!savedOptions} onPress={resetOptions} />
          </SettingsSection>
          <SettingsNote>Reasoning, context window, and speed apply to new sessions. Model instructions apply whenever this model runs.</SettingsNote>
        </> : modelId === "auto" ? <SettingsNote>Auto selects a model from the first prompt and uses routing options. A TypeSafe key is required on the run host.</SettingsNote> : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ModelInstructions({ modelId, value }: { modelId: string; value: string }) {
  const app = useApp();
  const [draft, setDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  function save() {
    if (draft === null) return;
    const next = { ...app.personal.current().modelInstructions };
    if (draft) next[modelId] = draft;
    else delete next[modelId];
    const result = app.personal.set({ modelInstructions: next });
    setFailed(result === "invalid");
    if (result === "saved") setDraft(null);
  }
  return <SettingsSection title="Model instructions">
    <TextInput accessibilityLabel="Model instructions" value={draft ?? value} onChangeText={(value) => { setDraft(value); setFailed(false); }} onBlur={save}
      multiline maxLength={20000} placeholder="Instructions for this model…" textAlignVertical="top"
      className="min-h-32 px-4 py-3 text-base text-foreground" />
    {failed ? <AppText accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">These instructions could not be saved. The settings size limit was reached.</AppText> : null}
  </SettingsSection>;
}
