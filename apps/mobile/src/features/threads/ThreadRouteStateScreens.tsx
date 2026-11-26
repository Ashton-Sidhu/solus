import { createContext, use, type ReactNode } from "react";
import { useGT } from "gt-react-native";
import { View } from "react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EmptyState } from "../../components/ui/EmptyState";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { ThreadScreenFallback } from "./ThreadScreenHost";

// The inspector pane's bar belongs to ThreadInspectorHeader; the fallback must not draw its own.
export const InspectorHeaderShownContext = createContext(false);

function ThreadRouteFallbackLayout(props: { readonly children: ReactNode }) {
  const gt = useGT();
  const goBack = useWorkspaceBackNavigation();
  const inspectorHeaderShown = use(InspectorHeaderShownContext);
  return (
    <ThreadScreenFallback
      header={
        inspectorHeaderShown ? undefined : (
          <AppBar title={gt("Thread")} onBackToList={goBack} hideBottomBorder />
        )
      }
    >
      {props.children}
    </ThreadScreenFallback>
  );
}

export function OpeningThreadLoadingScreen() {
  const gt = useGT();
  return (
    <ThreadRouteFallbackLayout>
      <View className="flex-1 flex-row items-center justify-center gap-2 px-6">
        <AppActivityIndicator size="small" />
        <Text className="shrink text-sm text-foreground-muted">{gt("Opening thread…")}</Text>
      </View>
    </ThreadRouteFallbackLayout>
  );
}

export function ThreadUnavailableScreen(props: {
  readonly detail?: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  const gt = useGT();
  return (
    <ThreadRouteFallbackLayout>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        className="bg-screen flex-1 android:bg-transparent"
      >
        <EmptyState
          title={gt("Thread unavailable")}
          detail={props.detail ?? gt("This thread is not available in the current mobile snapshot.")}
          actionLabel={props.actionLabel}
          onAction={props.onAction}
        />
      </ScrollView>
    </ThreadRouteFallbackLayout>
  );
}
