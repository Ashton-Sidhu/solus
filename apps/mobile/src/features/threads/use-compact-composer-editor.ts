// Adapted from T3 Code apps/mobile/src/components/ComposerSurface.tsx (MIT; see UPSTREAM.md).
import { useState } from "react";
import { I18nManager, Platform } from "react-native";
import {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { ScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  COMPOSER_TRANSITION_DURATION_MS,
  compactEditorInsets,
  nativeComposerOverflowsRow,
  oneRowEditorHeight,
  oneRowEditorInset,
} from "./composer-layout";

const EXPANDED_EDITOR_INSET = 14;
const EXPANDED_EDITOR_BOTTOM = 52;

export function useCompactComposerEditor(
  text: ScaledTextRole,
  value: string,
  animate: boolean,
) {
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [compactWidth, setCompactWidth] = useState(0);
  const contentHeight = contentSize.height;
  const rowWidth = useSharedValue(0);
  const editorX = useSharedValue(0);
  const editorWidth = useSharedValue(0);
  const inset = oneRowEditorInset(
    text,
    Platform.OS === "android" ? "android" : "ios",
  );
  const minimum = oneRowEditorHeight(text.lineHeight, inset);
  const height = Math.max(
    minimum,
    Math.min(text.lineHeight * 4 + 2 * inset, contentHeight + 2 * inset),
  );
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too so widening cannot trigger a collapse loop.
  const isExpanded =
    value.length > 0 &&
    nativeComposerOverflowsRow(contentSize, compactWidth, text.lineHeight);
  const compactRowHeight = Math.max(44, minimum);
  const compactBottom = (compactRowHeight - minimum) / 2;
  const isRTL = I18nManager.isRTL;
  const expandedRowHeight = height + EXPANDED_EDITOR_BOTTOM;
  const expansion = useDerivedValue(() => {
    const target = isExpanded ? 1 : 0;
    return animate
      ? withTiming(target, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : target;
  });
  const editorStyle = useAnimatedStyle(() => {
    const compactInsets = compactEditorInsets({
      slotX: editorX.value,
      slotWidth: editorWidth.value,
      rowWidth: rowWidth.value,
      isRTL,
    });
    const progress = expansion.value;
    // Hanging from the row top lets the text ride the growing edge and ignore the stale
    // height measured while it still wrapped in the compact slot. Layout props only:
    // Reanimated applies transforms frames ahead of layout, which tore the text from its frame.
    return {
      position: "absolute",
      overflow: "hidden",
      // The compact slot is unknown until its first layout, so the editor would draw over the + button.
      opacity: isExpanded || editorWidth.value > 0 ? 1 : 0,
      height,
      top: compactBottom * (1 - progress),
      left:
        compactInsets.left +
        (EXPANDED_EDITOR_INSET - compactInsets.left) * progress,
      // Snapping the far edge keeps the line from rewrapping while the near edge moves.
      right: isExpanded ? EXPANDED_EDITOR_INSET : compactInsets.right,
    };
  });
  const containerStyle = useAnimatedStyle(() => ({
    height:
      compactRowHeight +
      (expandedRowHeight - compactRowHeight) * expansion.value,
  }));
  return {
    isExpanded,
    containerStyle,
    // The expanded toolbar takes the row the text is leaving; reveal it once the text has lifted.
    // An entering animation hides it from its first frame, which a shared-value opacity cannot.
    toolbarControlsEntering:
      animate && isExpanded
        ? FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS / 2)
            .duration(COMPOSER_TRANSITION_DURATION_MS / 2)
            .reduceMotion(ReduceMotion.System)
        : undefined,
    editorStyle,
    onRowLayout: (event: { nativeEvent: { layout: { width: number } } }) => {
      rowWidth.set(event.nativeEvent.layout.width);
    },
    onEditorLayout: (event: {
      nativeEvent: { layout: { x: number; width: number } };
    }) => {
      // The expanded toolbar gives this slot to the model control. Keep the
      // compact geometry for the return transition, rather than recording zero.
      if (!isExpanded) {
        editorX.set(event.nativeEvent.layout.x);
        editorWidth.set(event.nativeEvent.layout.width);
        setCompactWidth(Math.max(0, event.nativeEvent.layout.width - 8));
      }
    },
    editorProps: {
      singleLineCentered: !isExpanded,
      scrollEnabled:
        Platform.OS === "android" || contentHeight >= text.lineHeight * 4,
      contentInsetVertical: inset,
      onContentSizeChange: (size: { width: number; height: number }) => {
        setContentSize(size);
      },
      style: { flex: 1 },
    },
  };
}
