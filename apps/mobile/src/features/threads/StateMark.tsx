import { toServerClock } from "@t3tools/client-runtime/clock";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMessages } from "gt-react-native";
import { Platform, Text as RNText, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { DotMatrix } from "../../components/ui/DotMatrix";
import { STATE_GLYPHS, type StateMark } from "./state-marks";
import { dotMarkShowsElapsedTime } from "./threadListV2";
import { useVisibleSecondClock } from "./use-visible-second-clock";

// DM Sans has no tabular figures, so a ticking timer in it reflows the row every second.
const TABULAR_DURATION_STYLE = {
  fontFamily: Platform.OS === "ios" ? "System" : "sans-serif",
  fontWeight: "700",
  fontVariant: ["tabular-nums"],
} as const;

/** The elapsed time beside a working mark, in the host's clock. */
export function StateMarkDuration(props: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: string | null;
  readonly leadingSpace: boolean;
}) {
  const messages = useMessages();
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs));
  if (!Number.isFinite(startedAtMs)) return null;
  return (
    <>
      {props.leadingSpace ? " " : null}
      <RNText style={TABULAR_DURATION_STYLE}>
        {formatWorkingDurationLabel(
          toServerClock(props.environmentId, nowMs) - startedAtMs,
          messages,
        )}
      </RNText>
    </>
  );
}

/**
 * A state mark in a card: a dot mark with its time, or a line glyph with its
 * word. The card names the state for speech; this view is not read.
 */
export function StateMarkView(props: {
  readonly mark: StateMark;
  readonly environmentId: EnvironmentId;
}) {
  const { mark } = props;
  const messages = useMessages();
  if (mark.kind === "dot") {
    const showsTime = mark.startedAt !== null && dotMarkShowsElapsedTime(mark.mark);
    return (
      <View
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        className="flex-row items-center gap-1"
      >
        <DotMatrix
          mark={mark.mark}
          dotClassName={mark.mark === "offline" ? "bg-foreground-muted" : "bg-adaptive-sky-600-400"}
        />
        {showsTime ? (
          <Text className="text-xs font-t3-bold text-adaptive-sky-600-400">
            <StateMarkDuration
              environmentId={props.environmentId}
              startedAt={new Date(mark.startedAt!).toISOString()}
              leadingSpace={false}
            />
          </Text>
        ) : null}
      </View>
    );
  }
  const glyph = STATE_GLYPHS[mark.glyph];
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-1"
    >
      <SymbolView
        name={glyph.icon}
        size={13}
        tintColorClassName={glyph.iconTintClassName}
        type="monochrome"
        weight="semibold"
      />
      {"glyphOnly" in glyph ? null : (
        <Text className={`text-xs font-t3-bold ${glyph.className}`}>{messages(glyph.label)}</Text>
      )}
    </View>
  );
}
