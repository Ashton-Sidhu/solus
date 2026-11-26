import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Animated as NativeAnimated, StyleSheet, View } from "react-native";
import Animated, {
  measure,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";
import { threadOpeningBottomInset } from "./thread-feed-scroll-position";

export const ThreadOpeningViewport = createContext<{
  viewport: AnimatedRef<View>;
  scrollOffset: SharedValue<number>;
  composerInset: SharedValue<number>;
  composerKeyboardTranslation: SharedValue<number>;
} | null>(null);

// During opening, UIKit or Android can apply a new scroll offset before Fabric
// commits its screen coordinates. Read the layer's offset in scroll *content*
// coordinates. The native scroll value below follows the scroll view in the same frame.
function MeasureOpeningColumn(props: {
  viewport: AnimatedRef<View>;
  layer: AnimatedRef<View>;
  end: SharedValue<number | null>;
  scrollOffset: SharedValue<number>;
  composerInset: SharedValue<number>;
}) {
  const { viewport, layer, end, scrollOffset, composerInset } = props;
  const previousAnchor = useSharedValue<number | null>(null);
  useFrameCallback(() => {
    const screen = measure(viewport);
    const content = measure(layer);
    if (screen && content && screen.height > 0 && content.height > 0) {
      const relativeEnd = screen.height - content.y;
      const anchor = relativeEnd + scrollOffset.value - composerInset.value;
      // The scroll view can deliver its opening offset one frame after its size.
      if (end.value !== null || (previousAnchor.value !== null && Math.abs(anchor - previousAnchor.value) < 1)) {
        end.value = relativeEnd;
      }
      previousAnchor.value = anchor;
    }
  });
  return null;
}

export function ThreadOpeningColumn({
  placingFromEnd, children, ...layerProps
}: Pick<ComponentProps<typeof NativeAnimated.View>, "style" | "pointerEvents"> & { placingFromEnd: boolean; children?: ReactNode }) {
  const placement = useContext(ThreadOpeningViewport);
  const layer = useAnimatedRef<View>();
  const end = useSharedValue<number | null>(null);
  const style = useAnimatedStyle(() => ({
    opacity: placingFromEnd && end.value === null ? 0 : 1,
    transform: [{
      translateY: placingFromEnd && placement
        ? (end.value ?? 0) + placement.scrollOffset.value - threadOpeningBottomInset(
            placement.composerInset.value,
            placement.composerKeyboardTranslation.value,
          )
        : 0,
    }],
  }), [placingFromEnd, placement]);
  return (
    <NativeAnimated.View {...layerProps} ref={layer} collapsable={false}>
      <View pointerEvents="box-none" style={placingFromEnd ? styles.origin : styles.contents}>
        <Animated.View pointerEvents="box-none" style={placingFromEnd ? [styles.column, style] : styles.contents}>
          {children}
        </Animated.View>
      </View>
      {placingFromEnd && placement ? (
        <MeasureOpeningColumn {...placement} layer={layer} end={end} />
      ) : null}
    </NativeAnimated.View>
  );
}

const styles = StyleSheet.create({
  origin: { position: "absolute", top: 0, left: 0, right: 0, height: 0 },
  column: { position: "absolute", bottom: 0, left: 0, right: 0 },
  contents: { display: "contents" },
});
