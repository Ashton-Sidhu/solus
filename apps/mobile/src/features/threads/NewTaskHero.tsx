import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { T, useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, type AnimatedStyle } from "react-native-reanimated";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { NativeScrollEdgeEffectsContext } from "../../native/NativeScrollViewMarker";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
export const SHORT_DRAFT_VIEWPORT_HEIGHT = 380;
const HEADING_PROJECT_SLOT = "\uE000";
export function NewTaskProjectHero(props: {
  title: string;
  disabled: boolean;
  chooseProject: () => void;
  children: ReactNode;
}) {
  const gt = useGT();
  const headingParts = gt("What should we build in {project}?", {
    project: HEADING_PROJECT_SLOT,
  }).split(HEADING_PROJECT_SLOT);
  const headingBefore = headingParts[0] ?? "";
  const headingAfter = headingParts[1] ?? "";
  const headingBreak = headingBefore.trimEnd().lastIndexOf(" ");
  const headingFirstLine = headingBreak < 0 ? headingBefore : headingBefore.slice(0, headingBreak);
  const headingLead = headingBreak < 0 ? "" : headingBefore.slice(headingBreak + 1);
  return (
    <View className="items-center gap-6 px-6" testID="new-task-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          {headingFirstLine}
        </Text>
        <View className="max-w-full flex-row items-center justify-center">
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">
            {headingLead}
          </Text>
          <Pressable
            accessibilityHint={gt("Opens the project picker")}
            accessibilityLabel={props.title}
            accessibilityRole="button"
            disabled={props.disabled}
            onPress={props.chooseProject}
            className="min-w-0 max-w-[250px] border-b border-foreground-muted active:opacity-65"
          >
            <Text
              className="text-2xl font-t3-medium tracking-tight text-foreground"
              numberOfLines={1}
            >
              {props.title}
            </Text>
          </Pressable>
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">
            {headingAfter}
          </Text>
        </View>
      </View>

      {props.children}
    </View>
  );
}
export function NewTaskScratchHero(props: {
  disabled: boolean;
  chooseProject: () => void;
  environmentControl: ReactNode;
  children?: ReactNode;
}) {
  const gt = useGT();
  return (
    <View className="items-center gap-2 px-6" testID="new-task-hero">
      <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
        <T>What should we work on?</T>
      </Text>
      <View className="flex-row flex-wrap items-center justify-center gap-x-1">
        <ComposerInlineControl
          accessibilityHint={gt("Opens the project picker")}
          accessibilityLabel={gt("No project")}
          chevronDirection="right"
          disabled={props.disabled}
          icon="folder"
          label={gt("No project")}
          onPress={props.chooseProject}
        />
        {props.environmentControl}
      </View>
      {props.children}
    </View>
  );
}

export function draftHeroContent(props: {
  scratch: boolean;
  title: string;
  disabled: boolean;
  chooseProject: () => void;
  environmentControl: ReactNode;
  notice?: ReactNode;
}) {
  return (
    headerInset: number,
    bottomInsetStyle: AnimatedStyle<Pick<ViewStyle, "bottom">>,
    viewportHeight: number,
    heroLayoutHeight: number,
  ) => (
    <DraftViewport {...{ headerInset, bottomInsetStyle, viewportHeight, heroLayoutHeight }}>
      {props.scratch ? (
        <NewTaskScratchHero
          disabled={props.disabled}
          chooseProject={props.chooseProject}
          environmentControl={props.environmentControl}
        >
          {props.notice}
        </NewTaskScratchHero>
      ) : (
        <NewTaskProjectHero
          disabled={props.disabled}
          chooseProject={props.chooseProject}
          title={props.title}
        >
          {props.environmentControl}
          {props.notice}
        </NewTaskProjectHero>
      )}
    </DraftViewport>
  );
}

export function DraftViewport({
  headerInset,
  bottomInsetStyle,
  viewportHeight,
  heroLayoutHeight,
  children,
}: {
  headerInset: number;
  bottomInsetStyle: AnimatedStyle<Pick<ViewStyle, "bottom">>;
  viewportHeight: number;
  heroLayoutHeight: number;
  children: ReactNode;
}) {
  const { height } = useReanimatedKeyboardAnimation();
  // Keep the heading in place as the composer grows. The smaller scroll viewport
  // still lets the user reach the project and host above a tall composer.
  const heroLayout = useAnimatedStyle(() => ({
    minHeight: Math.max(0, heroLayoutHeight + height.value),
  }));
  return viewportHeight < SHORT_DRAFT_VIEWPORT_HEIGHT ? null : (
    <NativeScrollEdgeEffectsContext
      value={{ top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" }}
    >
      <Animated.View
        collapsable={false}
        style={[
          {
            position: "absolute",
            top: headerInset,
            left: 0,
            right: 0,
            overflow: "hidden",
          },
          bottomInsetStyle,
        ]}
      >
        <ScrollView
          alwaysBounceVertical={false}
          className="flex-1"
          contentInsetAdjustmentBehavior="never"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          testID="new-task-hero-scroll"
        >
          <Animated.View style={[{ alignItems: "center", paddingVertical: 24 }, heroLayout]}>
            <View style={{ flexGrow: 1 }} />
            {children}
            <View style={{ flexGrow: 2 }} />
          </Animated.View>
        </ScrollView>
      </Animated.View>
    </NativeScrollEdgeEffectsContext>
  );
}
