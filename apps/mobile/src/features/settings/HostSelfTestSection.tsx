import { View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { HostConnectionStages } from "../hosts/HostConnectionStages";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsSection } from "./components/SettingsSection";

/** The host tests its own connection, as the desktop and web Access tab shows it (docs/plans/host-readiness.md). */
export function HostSelfTestSection(props: { readonly hostId: string }) {
  const app = useApp();
  const selfTest = useListened(app.hostCloudLink.changes, () => app.hostCloudLink.selfTestOf(props.hostId));
  const isRunning = selfTest?.kind === "running";
  const test = selfTest?.kind === "done" ? selfTest.test : null;
  const label = isRunning ? "Testing" : selfTest ? "Test again" : "Run connection test";
  return (
    <View className="gap-3">
      <SettingsSection title="Connection test">
        <SettingsActionRow
          icon="arrow.clockwise"
          label={label}
          loading={isRunning}
          disabled={isRunning}
          onPress={() => void app.hostCloudLink.runSelfTest(props.hostId)}
        />
      </SettingsSection>
      {selfTest?.kind === "error" ? (
        <SettingsNote tone="danger">{`The test could not run: ${selfTest.message}`}</SettingsNote>
      ) : (
        <SettingsNote>
          {test?.summary ?? "The host tests Solus Cloud, its tunnel, port 7844, and its server. It cannot test another device's network."}
        </SettingsNote>
      )}
      {test ? (
        <View className="gap-3 px-2">
          <HostConnectionStages stages={test.stages} />
          {test.problem?.hint ? <Text selectable className="text-xs text-foreground-secondary">{test.problem.hint}</Text> : null}
          {test.problem ? <Text selectable className="text-xs text-foreground-secondary">{`Fix: ${test.problem.fix}`}</Text> : null}
          {test.facts.map((fact) => (
            <Text key={fact.label} selectable className="text-xs text-foreground-secondary">{`${fact.label}: ${fact.value}`}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
