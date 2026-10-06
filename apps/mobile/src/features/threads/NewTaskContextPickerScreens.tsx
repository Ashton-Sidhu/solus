// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx (MIT, see UPSTREAM.md).
import type { HostOperatingSystem } from "@solus/contracts/types";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MaterialListRow } from "../../components/MaterialListRow";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import {
  EnvironmentMachineSymbol,
  type EnvironmentMachineKind,
} from "../../components/EnvironmentMachineSymbol";
import { cn } from "../../lib/cn";

/** The glyph a Solus host wears: T3's machine kinds by operating system. */
export function hostMachineKind(os: HostOperatingSystem | undefined): EnvironmentMachineKind {
  switch (os) {
    case "macos":
      return "laptop";
    case "windows":
      return "desktop";
    case "linux":
      return "linux";
    default:
      return "server";
  }
}

function SelectionRow(props: {
  readonly icon?: ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.title}
        subtitle={props.subtitle}
        leading={props.icon}
        trailing={
          props.selected ? (
            <SymbolView name="checkmark" size={20} tintColorClassName="accent-focus" />
          ) : null
        }
        accessibilityRole="radio"
        accessibilityState={{ checked: props.selected }}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon ?? null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-2xl bg-grouped-card"
      }
    >
      {props.children}
    </View>
  );
}

export interface NewTaskEnvironmentChoice {
  readonly hostId: string;
  readonly label: string;
  readonly os: HostOperatingSystem | undefined;
  /** Where the task runs on that host: the same repository's checkout there. */
  readonly subtitle?: string;
}

/**
 * Where the new task runs: one of the hosts that has this project (or, for a
 * task without a project, any host). A T3 "environment" is a Solus host.
 */
export function NewTaskEnvironmentPicker(props: {
  readonly visible: boolean;
  readonly environments: ReadonlyArray<NewTaskEnvironmentChoice>;
  readonly selectedHostId: string;
  readonly onSelect: (hostId: string) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-sheet" collapsable={false}>
        <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
          <Text accessibilityRole="header" className="font-t3-extrabold text-lg text-foreground">
            Host
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onClose}
            className="active:opacity-70"
          >
            <Text className="font-t3-bold text-sm text-primary-text">Done</Text>
          </Pressable>
        </View>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          showsVerticalScrollIndicator={false}
        >
          <PickerSurface>
            {props.environments.map((environment, index) => (
              <SelectionRow
                key={environment.hostId}
                icon={
                  <EnvironmentMachineSymbol
                    kind={hostMachineKind(environment.os)}
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon-muted"
                  />
                }
                isLast={index === props.environments.length - 1}
                onPress={() => {
                  void Haptics.selectionAsync();
                  props.onSelect(environment.hostId);
                  props.onClose();
                }}
                selected={props.selectedHostId === environment.hostId}
                subtitle={environment.subtitle}
                title={environment.label}
              />
            ))}
          </PickerSurface>
        </ScrollView>
      </View>
    </Modal>
  );
}
