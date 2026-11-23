import type { ComponentProps, ReactNode } from "react";
import { useGT } from "gt-react-native";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView as ScrollView } from "../../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { FormField, SelectRow } from "./ScheduledTaskFields";
import { SettingsScreen } from "./SettingsScreen";
import { SettingsSection } from "./SettingsSection";

export function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{label}, {value}", { label: props.label, value: props.value })}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text textRole="body" className="text-foreground">
        {props.label}
      </Text>
      <Text
        textRole="footnote"
        className="min-w-0 flex-1 text-right text-foreground-muted"
        numberOfLines={1}
      >
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

export function ScheduledTaskEditor({
  title,
  guardBack,
  children,
}: {
  title: string;
  guardBack: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen
      title={title}
      // Native Back pops before removal guards; a bar action lets the guard run first.
      guardBack={guardBack}
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
        {children}
      </ScrollView>
    </SettingsScreen>
  );
}

export function ScheduledTaskDetails(props: {
  host: Omit<ComponentProps<typeof SelectRow>, "label">;
  name: Omit<ComponentProps<typeof FormField>, "label" | "placeholder">;
  prompt: ReactNode;
  project: Omit<ComponentProps<typeof SelectRow>, "label">;
  model: Omit<ComponentProps<typeof PickerRow>, "label" | "borderTop">;
}) {
  const gt = useGT();
  return (
    <>
      <SettingsSection>
        <SelectRow label={gt("Runs on")} {...props.host} />
      </SettingsSection>
      <SettingsSection title={gt("Task", { $context: "section heading for a scheduled task" })}>
        <FormField label={gt("Name")} placeholder={gt("Check for issues")} {...props.name} />
        {props.prompt}
      </SettingsSection>
      <SettingsSection title={gt("Context", { $context: "section heading: project and model" })}>
        <SelectRow label={gt("Project")} {...props.project} />
        <PickerRow label={gt("Model")} borderTop {...props.model} />
      </SettingsSection>
    </>
  );
}
