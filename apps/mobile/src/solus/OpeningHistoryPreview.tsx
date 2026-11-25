import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { GroupedThreadFeedRow } from "../features/threads/pending-thread-feed";

interface Props {
  readonly style?: StyleProp<ViewStyle>;
  readonly enabled: boolean;
  readonly settling: boolean;
  readonly rows: readonly GroupedThreadFeedRow[];
  readonly renderRow: (row: { item: GroupedThreadFeedRow; index: number }) => ReactNode;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly children: ReactNode;
}

// The native list owns interaction. Give the latest reply a frame to paint at the
// same inset before the list starts measuring the full page behind it.
export function OpeningHistoryPreview(props: Props) {
  const last = props.rows.at(-1);
  const tail = props.enabled && props.settling && last?.type === "message" && last.message.role === "assistant"
    ? props.rows.slice(-3)
    : [];
  // Stop at a host card or attachment so it gets a single interactive mount in the list.
  const first = tail.findLastIndex((row) =>
    row.type !== "run-fold" && (row.type !== "message" || !!row.message.attachments?.length),
  ) + 1;
  const showPreview = first < tail.length;
  const [startList, setStartList] = useState(!showPreview);
  useEffect(() => {
    if (startList) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setStartList(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [startList]);

  return (
    <View className="flex-1" style={props.style}>
      {startList || !showPreview ? props.children : null}
      {showPreview ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}
        >
          <View style={{ position: "absolute", bottom: props.bottom, left: props.left, right: props.right }}>
            {tail.slice(first).map((item, index) =>
              props.renderRow({ item, index: props.rows.length - tail.length + first + index }),
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
