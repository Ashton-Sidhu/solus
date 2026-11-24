import type { BackgroundCommandWake } from "@solus/client-core/background-command-wake";
import { terminalOutputPlainText } from "@t3tools/shared/terminalOutput";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { WorkLogPressable } from "./work-log-layout";

export function BackgroundCommandRow({
  command,
  disclosure,
}: {
  readonly command: BackgroundCommandWake;
  readonly disclosure?: { readonly expanded: boolean; readonly toggle: () => void };
}) {
  const gt = useGT();
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = disclosure?.expanded ?? localExpanded;
  const label = gt("Background command");
  const status = command.exitCode === null
    ? gt("Finished")
    : gt("exit {code}", { code: command.exitCode });
  return (
    <View className="mb-2 max-w-full self-end">
      <WorkLogPressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${status}`}
        accessibilityState={{ expanded }}
        onPress={disclosure?.toggle ?? (() => setLocalExpanded((open) => !open))}
      >
        <SymbolView
          name={command.attention ? "exclamationmark.circle" : "terminal"}
          size={14}
          tintColorClassName={command.attention ? "text-danger-foreground" : "text-foreground-muted"}
        />
        <Text numberOfLines={1} className="max-w-[60%] shrink-0 font-t3-medium text-sm">
          {label}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="tail" className="min-w-0 shrink font-mono text-xs text-foreground-muted">
          {command.command}
        </Text>
        <Text className="shrink-0 text-xs text-foreground-muted">{status}</Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="text-foreground-muted"
        />
      </WorkLogPressable>
      {expanded ? (
        <View className="mt-1 gap-2 rounded-lg bg-subtle p-3">
          <Text selectable className="font-mono text-xs">{command.command}</Text>
          {command.output ? (
            <ScrollView nestedScrollEnabled className="max-h-60">
              <Text selectable className="font-mono text-xs">
                {terminalOutputPlainText(command.output)}
              </Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
