import type { ReactNode } from "react";
import { useGT } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SettingsScreen } from "./SettingsScreen";
import { ScreenScrollView as ScrollView } from "../../../components/ui/ScreenScrollView";
import type { AppBarMenu } from "../../../components/ui/AppBar.types";

export function ScheduledTaskListView(props: {
  disabled: boolean;
  onNew: () => void;
  menu: AppBarMenu;
  children: ReactNode;
}) {
  const gt = useGT(),
    insets = useSafeAreaInsets();
  return (
    <SettingsScreen
      title={gt("Scheduled tasks")}
      actions={[
        {
          accessibilityLabel: gt("New task"),
          icon: "plus",
          disabled: props.disabled,
          onPress: props.onNew,
        },
      ]}
      menus={[props.menu]}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}
