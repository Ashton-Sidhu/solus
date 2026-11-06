import { View } from "react-native";
import { connectionStageResultLabel, type ConnectionStageReport } from "@solus/contracts/host-connection";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

const RESULT_SYMBOLS = {
  ok: "checkmark.circle",
  failed: "xmark.circle.fill",
  unknown: "info.circle",
} as const;

/**
 * The way to a host, one stage per row, in order (docs/plans/host-readiness.md).
 * The word beside each stage carries the result; the mark only repeats it.
 */
export function HostConnectionStages(props: { readonly stages: readonly ConnectionStageReport[] }) {
  return (
    <View className="gap-1.5">
      {props.stages.map((report) => (
        <View key={report.stage} className="flex-row gap-2">
          <SymbolView
            name={RESULT_SYMBOLS[report.result]}
            size={14}
            tintColorClassName={report.result === "failed" ? "accent-danger-foreground" : "accent-icon-muted"}
            type="monochrome"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row justify-between gap-2">
              <Text className="shrink text-xs font-t3-medium text-foreground">{report.label}</Text>
              <Text className={report.result === "failed" ? "text-xs text-danger-foreground" : "text-xs text-foreground-muted"}>
                {connectionStageResultLabel(report.result)}
              </Text>
            </View>
            {report.detail ? (
              <Text selectable className="text-xs text-foreground-secondary">
                {report.detail}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}
