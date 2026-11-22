import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
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
export function DraftViewport({
  headerInset,
  bottomInset,
  viewportHeight,
  children,
}: {
  headerInset: number;
  bottomInset: number;
  viewportHeight: number;
  children: ReactNode;
}) {
  return viewportHeight < SHORT_DRAFT_VIEWPORT_HEIGHT ? null : (
    <NativeScrollEdgeEffectsContext
      value={{ top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" }}
    >
      <View
        collapsable={false}
        style={{
          position: "absolute",
          top: headerInset,
          bottom: bottomInset,
          left: 0,
          right: 0,
          overflow: "hidden",
        }}
      >
        <ScrollView
          alwaysBounceVertical={false}
          className="flex-1"
          contentInsetAdjustmentBehavior="never"
          contentContainerClassName="grow items-center"
          contentContainerStyle={{ paddingVertical: 24 }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          testID="new-task-hero-scroll"
        >
          <View style={{ flexGrow: 1 }} />
          {children}
          <View style={{ flexGrow: 2 }} />
        </ScrollView>
      </View>
    </NativeScrollEdgeEffectsContext>
  );
}
