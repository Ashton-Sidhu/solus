import { useState } from "react";
import { TextInput, View } from "react-native";
import { settingsDefinitions } from "@solus/client-core/settings-definitions";
import { PROVIDERS } from "@solus/contracts/provider-model-settings";
import { useApp, useListened } from "../../app/app-context";
import { AppText } from "../../components/AppText";
import { effortChoices, effortLabel, modelChoices, modelLabel } from "../conversation/lib/run-settings";
import { PolicyLockNote } from "../policy/PolicyLockNote";
import { useManagedSettingLines } from "../policy/use-host-policy";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

const workerSetting = settingsDefinitions["sessions.worker-model"];
const instructionsSetting = settingsDefinitions["sessions.delegation-instructions"];

export function DelegationSettingsSection() {
  const { personal } = useApp();
  const worker = useListened(personal.changes, () => personal.current().workerModel);
  const instructions = useListened(personal.changes, () => personal.current().delegationInstructions);
  const workerPolicy = useManagedSettingLines("workerModel");
  const instructionsPolicy = useManagedSettingLines("delegationInstructions");
  const [isChoosingModel, setIsChoosingModel] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  function saveInstructions() {
    if (draft === null) return;
    const result = personal.set({ delegationInstructions: draft });
    setSaveFailed(result === "invalid");
    if (result === "saved" || draft === instructions) setDraft(null);
  }

  return (
    <View className="gap-3">
      <SettingsSection title={settingsDefinitions["sessions.section-delegation"].label}>
        <SettingsRow
          icon="sparkles"
          label={workerSetting.label}
          value={worker ? modelLabel(worker.provider, worker.model) : "Inherit from parent"}
          onPress={() => setIsChoosingModel(!isChoosingModel)}
        />
        {isChoosingModel ? (
          <>
            <SettingsChoiceRow
              separated
              label="Inherit from parent"
              selected={!worker}
              onPress={() => { personal.set({ workerModel: null }); setIsChoosingModel(false); }}
            />
            {PROVIDERS.map((provider) =>
              modelChoices(provider.id, worker?.provider === provider.id ? worker.model : null).map((model) => (
                <SettingsChoiceRow
                  key={`${provider.id}:${model.id}`}
                  separated
                  label={model.label}
                  description={provider.label}
                  selected={worker?.provider === provider.id && worker.model === model.id}
                  onPress={() => {
                    if (worker?.provider !== provider.id || worker.model !== model.id) {
                      personal.set({ workerModel: { provider: provider.id, model: model.id, reasoningEffort: undefined } });
                    }
                    setIsChoosingModel(false);
                  }}
                />
              )),
            )}
          </>
        ) : null}
      </SettingsSection>
      <PolicyLockNote lines={workerPolicy} />
      <SettingsNote>{workerSetting.description}</SettingsNote>
      {worker ? (
        <SettingsSection title={settingsDefinitions["providers.reasoning"].label}>
          <SettingsChoiceRow
            label="Model default"
            selected={worker.reasoningEffort === undefined}
            onPress={() => personal.set({ workerModel: { ...worker, reasoningEffort: undefined } })}
          />
          {effortChoices(worker.provider, worker.model).map((effort) => (
            <SettingsChoiceRow
              key={effort}
              separated
              label={effortLabel(effort)}
              selected={worker.reasoningEffort === effort}
              onPress={() => personal.set({ workerModel: { ...worker, reasoningEffort: effort } })}
            />
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection title={instructionsSetting.label}>
        <TextInput
          accessibilityLabel={instructionsSetting.label}
          className="min-h-32 px-4 py-3 text-base text-foreground"
          multiline
          maxLength={20_000}
          textAlignVertical="top"
          value={draft ?? instructions}
          onChangeText={(value) => { setDraft(value); setSaveFailed(false); }}
          onBlur={saveInstructions}
        />
        {saveFailed ? <AppText accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">Could not save delegation instructions.</AppText> : null}
      </SettingsSection>
      <PolicyLockNote lines={instructionsPolicy} />
      <SettingsNote>{instructionsSetting.description}</SettingsNote>
    </View>
  );
}
