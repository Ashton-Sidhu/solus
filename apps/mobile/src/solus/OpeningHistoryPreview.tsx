import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { GroupedThreadFeedRow } from "../features/threads/pending-thread-feed";

interface Props {
  readonly style?: StyleProp<ViewStyle>;
  readonly firstIndex: number;
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
  const showPreview = props.firstIndex < props.rows.length;
  const [startList, setStartList] = useState(!showPreview);
  const [previewLaidOut, setPreviewLaidOut] = useState(false);
  useEffect(() => {
    if (startList || !previewLaidOut) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setStartList(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [startList, previewLaidOut]);
  const firstIndex = startList ? props.firstIndex : Math.max(props.firstIndex, props.rows.length - 1);

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
          <View
            onLayout={() => setPreviewLaidOut(true)}
            style={{ position: "absolute", bottom: props.bottom, left: props.left, right: props.right }}
          >
            {props.rows.slice(firstIndex).map((item, index) =>
              props.renderRow({ item, index: firstIndex + index }),
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
