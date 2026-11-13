import { View } from "react-native";
import type {
  PullRequestWatchMark,
  PullRequestWatchMarkTone,
  PullRequestWatchWake,
} from "@solus/client-core/pull-request-watch-wake";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

const MARK_ICON = {
  "checks-failed": "xmark.circle.fill",
  "checks-passed": "checkmark.circle",
  "all-checks-passed": "checkmark.circle",
  "no-checks": "clock",
  remarks: "text.bubble",
  conflicting: "arrow.triangle.merge",
  closed: "arrow.triangle.pull",
  stopped: "eye.slash",
} as const satisfies { [Kind in PullRequestWatchMark["kind"]]: AppSymbolName };

const TONE_TINT = {
  failing: "accent-danger-foreground",
  passing: "accent-adaptive-emerald-600-400",
  pending: "accent-warning-foreground",
  review: "accent-adaptive-violet-600-400",
  quiet: "accent-icon-muted",
} as const satisfies { [Tone in PullRequestWatchMarkTone]: string };

/** A watch's news as icons with counts, as desktop draws it: "#42 ⊗ 2 💬 1".
 *  The row's accessibility label carries the same news in words. */
export function PullRequestWatchMarks(props: {
  readonly wake: PullRequestWatchWake;
  readonly marks: readonly PullRequestWatchMark[];
}) {
  return (
    <View className="min-w-0 shrink flex-row items-center gap-2.5 overflow-hidden opacity-70" importantForAccessibility="no-hide-descendants">
      <Text className="text-sm text-foreground-muted">#{props.wake.number}</Text>
      {props.marks.map((mark) => (
        <View key={mark.kind} className="flex-row items-center gap-1">
          <SymbolView
            name={MARK_ICON[mark.kind]}
            size={13}
            weight="semibold"
            tintColorClassName={TONE_TINT[mark.tone]}
            type="monochrome"
          />
          {mark.figure ? (
            <Text className="text-sm text-foreground-muted" style={{ fontVariant: ["tabular-nums"] }}>
              {mark.figure}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
