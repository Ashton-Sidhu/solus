// Adapted from T3 Code apps/mobile/src/features/home/ThreadUndoNotice.android.tsx (MIT, see UPSTREAM.md).
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeOut,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type EntryAnimationsValues,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { threadUndoNotices, type ThreadUndoNotice as Notice } from "./thread-undo-notice";

const SWIPE_TIMING = { duration: 160, reduceMotion: ReduceMotion.System };
const ENTER_TIMING = {
  duration: 180,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const NOTICE_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const noticeEntering = (values: EntryAnimationsValues) => {
  "worklet";
  return {
    initialValues: { originY: values.targetOriginY + values.targetHeight + 12 },
    animations: { originY: withTiming(values.targetOriginY, ENTER_TIMING) },
  };
};

/**
 * The Undo notice over a thread list, at the bottom above the Material
 * navigation bar, as Android places a snackbar. A horizontal swipe dismisses it.
 * WorkspaceTabsFrame gives the screen a zero bottom inset when the navigation
 * bar takes it, so the inset here clears only what the screen still owns.
 */
export function ThreadUndoNotice(props: { readonly visible: boolean }) {
  const notice = useSyncExternalStore(
    threadUndoNotices.subscribe,
    threadUndoNotices.current,
    threadUndoNotices.current,
  );
  // Replacing a notice must also cancel the native gesture tracking the old one.
  const [instance, setInstance] = useState({ notice, key: 0 });
  if (instance.notice !== notice) setInstance({ notice, key: instance.key + 1 });
  if (!props.visible || notice === null) return null;
  return <SwipeableUndoNotice key={instance.key} notice={notice} />;
}

function SwipeableUndoNotice(props: { readonly notice: Notice }) {
  const { notice } = props;
  const message = `${notice.action} thread`;
  const insets = useSafeAreaInsets();
  const translation = useSharedValue(0);
  const width = useSharedValue(0);

  useLayoutEffect(
    () => () => {
      cancelAnimation(translation);
    },
    [translation],
  );

  const gesture = useMemo(() => {
    const dismiss = () => {
      // A newer action can replace the notice while the swipe is animating out.
      if (threadUndoNotices.current() === notice) threadUndoNotices.dismiss();
    };
    return Gesture.Pan()
      .activeOffsetX([-10, 10])
      .failOffsetY([-12, 12])
      .onUpdate((event) => {
        translation.set(event.translationX);
      })
      .onEnd((event, success) => {
        if (
          success &&
          (Math.abs(event.translationX) > width.value * 0.25 ||
            (Math.abs(event.velocityX) > 800 && event.translationX * event.velocityX > 0))
        ) {
          const direction = Math.sign(event.translationX || event.velocityX);
          translation.set(
            withTiming(direction * (width.value + 24), SWIPE_TIMING, (finished) => {
              if (finished) runOnJS(dismiss)();
            }),
          );
        } else {
          translation.set(withTiming(0, SWIPE_TIMING));
        }
      });
  }, [notice, translation, width]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value }],
  }));

  // Clip the entrance above navigation; the notice intentionally covers the anchored FAB.
  return (
    <Animated.View
      className="absolute inset-x-3 z-[100] overflow-hidden"
      style={{ bottom: insets.bottom + 12 }}
      pointerEvents="box-none"
      exiting={NOTICE_EXITING}
      onLayout={(event) => {
        width.set(event.nativeEvent.layout.width);
      }}
    >
      <GestureDetector gesture={gesture}>
        <Animated.View collapsable={false} entering={noticeEntering} style={animatedStyle}>
          <View className="flex-row items-center gap-3 rounded-[20px] border border-border bg-card px-4 py-3">
            {/* Keep the dismiss target separate so TalkBack can also focus Undo. */}
            <View
              accessible
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              accessibilityLabel={message}
              accessibilityActions={[{ name: "dismiss", label: "Dismiss message" }]}
              onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === "dismiss") threadUndoNotices.dismiss(notice.threadKey);
              }}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
            <SymbolView name="checkmark.circle" size={20} tintColorClassName="accent-icon" />
            <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
              {message}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Undo: ${message}`}
              className="active:opacity-60"
              hitSlop={8}
              onPress={() => threadUndoNotices.undo()}
            >
              <Text className="text-sm font-t3-bold text-primary-text">Undo</Text>
            </Pressable>
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}
