import type { ComponentPropsWithRef } from "react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";

type Props<Item> = Omit<
  ComponentPropsWithRef<typeof AnimatedLegendList<Item>>,
  "contentInsetEndAdjustment"
> & {
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly keyboardOffset: number;
  readonly keyboardStickyEnabled?: boolean;
};

export function IosThreadFeedList<Item>({
  contentInsetEndAdjustment,
  keyboardOffset,
  keyboardStickyEnabled = true,
  ...listProps
}: Props<Item>) {
  const initialHeight = KeyboardController.state().height;
  const height = useSharedValue(initialHeight);
  const progress = useSharedValue(initialHeight > 0 ? 1 : 0);
  const followFrame = (event: { height: number; progress: number }) => {
    "worklet";
    height.value = event.height;
    progress.value = event.progress;
  };
  // iOS sends the destination on start. Only the moving and final frames
  // describe how much of the list is actually covered.
  useKeyboardHandler({ onMove: followFrame, onInteractive: followFrame, onEnd: followFrame }, []);
  const viewport = useAnimatedStyle(() => ({
    flex: 1,
    marginBottom:
      contentInsetEndAdjustment.value +
      (keyboardStickyEnabled ? Math.max(0, height.value - keyboardOffset * progress.value) : 0),
  }));
  return (
    <Animated.View style={viewport}>
      <NativeScrollViewMarker style={{ flex: 1 }}>
        <AnimatedLegendList {...listProps} />
      </NativeScrollViewMarker>
    </Animated.View>
  );
}
