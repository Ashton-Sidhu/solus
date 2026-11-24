import { T, useGT, Var } from "gt-react-native";
import { Pressable, View } from "react-native";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";

interface DraftEnvironmentControlProps {
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}

export function DraftEnvironmentControl(props: DraftEnvironmentControlProps) {
  const gt = useGT();
  const disconnected = props.connectionState !== "connected";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        disconnected
          ? gt("Choose environment, {label}, Offline", { label: props.label })
          : gt("Choose environment, {label}, Connected", { label: props.label })
      }
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-65"
    >
      <EnvironmentMachineSymbol
        kind={props.machineKind}
        size={13}
        tintColorClassName="accent-icon-muted"
      />
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        <T>
          on <Var>{props.label}</Var>
        </T>
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {disconnected ? <ConnectionStatusDot state="error" pulse={false} size={6} /> : null}
    </Pressable>
  );
}

export function DraftContextControls(props: DraftEnvironmentControlProps & {
  readonly projectLabel: string;
  readonly onChooseProject: () => void;
}) {
  const gt = useGT();
  const connected = props.connectionState === "connected";
  return (
    <View className="flex-row items-center gap-1 px-2">
      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityHint={gt("Opens the project picker")}
          accessibilityLabel={gt("Project: {project}", { project: props.projectLabel })}
          chevronDirection="right"
          disabled={props.disabled}
          icon="folder"
          label={props.projectLabel}
          maxWidth="100%"
          onPress={props.onChooseProject}
        />
      </View>
      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityLabel={connected
            ? gt("Choose environment, {label}, Connected", { label: props.label })
            : gt("Choose environment, {label}, Offline", { label: props.label })}
          chevronDirection="right"
          disabled={props.disabled}
          renderIcon={(size) => (
            <EnvironmentMachineSymbol kind={props.machineKind} size={size} tintColorClassName="accent-icon-muted" />
          )}
          label={props.label}
          maxWidth="100%"
          onPress={props.onChooseEnvironment}
          suffix={connected ? null : <ConnectionStatusDot state="error" pulse={false} size={6} />}
        />
      </View>
    </View>
  );
}
