import { useSyncExternalStore } from "react";
import { useNavigation } from "@react-navigation/native";
import { SettingsScreen } from "../features/settings/components/SettingsScreen";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import { ScreenScrollView } from "../components/ui/ScreenScrollView";
import { LinkSeveralEnvironmentsAction } from "../features/connection/LinkSeveralEnvironments";
import { LinkedEnvironmentsSection } from "../features/connection/LinkedEnvironmentsSection";
import {
  PERMISSION_MODE_TEXT,
  PERMISSION_MODES,
  PROVIDERS,
} from "@solus-mobile/features/conversation/lib/run-settings";
import {
  isWorkerModelChoiceSelected,
  workerModelAfterChoice,
  workerModelChoices,
} from "@solus-mobile/features/settings/worker-model-choices";
import type { PersonalSettings } from "@solus/contracts/settings";
import { hostReadinessCopy } from "@solus/client-core/host-readiness";
import { RATE_LIMIT_CHOICES } from "./settings-labels";
import { InstructionSettings } from "./SettingsPages";
import { solus, useSolusWorkspace } from "./runtime";

export function SolusHosts() {
  const navigation = useNavigation();
  const { environments } = useSolusWorkspace();
  return (
    <SettingsScreen title="Environments">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 py-4"
      >
        <SettingsSection title="Local environments">
          {environments.map((env) => (
            <SettingsRow
              key={env.environmentId}
              icon="desktopcomputer"
              label={env.environmentLabel}
              value={[env.displayUrl, hostReadinessCopy(solus.connections.readiness(env.environmentId), env.environmentLabel).label]
                .filter(Boolean).join(" · ")}
              onPress={() =>
                navigation.navigate("SettingsEnvironmentDetail", {
                  environmentId: env.environmentId,
                })
              }
            />
          ))}
          <SettingsRow
            icon="plus"
            label="Add environment"
            onPress={() => navigation.navigate("SettingsEnvironmentNew")}
          />
        </SettingsSection>
        {environments.filter((env) => env.connectionState === "connected").map((env) => (
          <LinkedEnvironmentsSection key={env.environmentId} {...env}>
            <LinkSeveralEnvironmentsAction {...env} />
          </LinkedEnvironmentsSection>
        ))}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SolusSessionSettings() {
  const settings = useSyncExternalStore(solus.personal.changes.subscribe, solus.personal.current);
  return (
    <SettingsScreen title="Sessions">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 py-4"
      >
        <SettingsSection title="Default agent">
          {PROVIDERS.map((provider) => (
            <SettingsRow
              key={provider.id}
              icon={settings.activeAgent === provider.id ? "checkmark" : "circle"}
              label={provider.label}
              onPress={() => solus.personal.set({ activeAgent: provider.id })}
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Default permissions">
          {PERMISSION_MODES.map((mode) => (
            <SettingsRow
              key={mode}
              icon={settings.defaultPermissionMode === mode ? "checkmark" : "circle"}
              label={PERMISSION_MODE_TEXT[mode].label}
              onPress={() => solus.personal.set({ defaultPermissionMode: mode })}
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Rate limit behavior">
          {RATE_LIMIT_CHOICES.map(({ mode, label }) => (
            <SettingsRow
              key={mode}
              icon={settings.rateLimitBehavior === mode ? "checkmark" : "circle"}
              label={label}
              onPress={() => solus.personal.set({ rateLimitBehavior: mode })}
            />
          ))}
        </SettingsSection>
        <WorkerModelSetting
          setting="workerModel"
          title="Default worker model"
          offLabel="Caller's model"
          footer="Used when a parent starts a child session without a provider or model."
          current={settings.workerModel}
        />
        <WorkerModelSetting
          setting="fallbackModel"
          title="Fallback model"
          offLabel="No fallback"
          footer="New sessions that an agent starts with no model use it while the default provider is out of usage."
          current={settings.fallbackModel}
        />
        <InstructionSettings />
        <SettingsSection>
          <SettingsSwitchRow
            icon="pencil"
            label="Name new sessions"
            value={settings.autoRenameSessions}
            onValueChange={(autoRenameSessions) => solus.personal.set({ autoRenameSessions })}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function WorkerModelSetting(props: {
  setting: "workerModel" | "fallbackModel";
  title: string;
  offLabel: string;
  footer: string;
  current: PersonalSettings["workerModel"];
}) {
  return (
    <SettingsSection title={props.title} footer={props.footer}>
      {workerModelChoices(props.current, props.offLabel).map((choice) => (
        <SettingsRow
          key={choice.key}
          icon={isWorkerModelChoiceSelected(choice, props.current) ? "checkmark" : "circle"}
          label={choice.label}
          onPress={() =>
            solus.personal.set({ [props.setting]: workerModelAfterChoice(choice, props.current) })
          }
        />
      ))}
    </SettingsSection>
  );
}
