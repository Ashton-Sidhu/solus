// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx (MIT, see UPSTREAM.md).
// The Environment picker is a route pushed in the new-task sheet, as T3; it
// reads the draft's host and project from its params instead of a flow provider.
import { isChat, NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
import type { HostOperatingSystem } from "@solus/contracts/types";
import * as Haptics from "expo-haptics";
import { useMemo, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import {
  EnvironmentMachineSymbol,
  type EnvironmentMachineKind,
} from "../../components/EnvironmentMachineSymbol";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { ScreenProps } from "../../navigation/routes";
import { groupProjectScopes, scopeOfProject } from "./new-task-project-selection";

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
  /** The draft's project on that host: the same repository's checkout, or the chat folder. */
  readonly projectPath: string;
  /** Where the task runs on that host: the same repository's checkout there. */
  readonly subtitle?: string;
}

/**
 * The hosts a new task could run on: the hosts that have the draft's project
 * (`hostId`, `projectPath`), or any host for a task without a project. A T3
 * "environment" is a Solus host.
 */
export function useNewTaskEnvironments(hostId: string, projectPath: string) {
  const app = useApp();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const projects = useListened(app.threads.changes, app.threads.projects);
  const chat = isChat(projectPath);
  const scope = useMemo(
    () => (chat ? null : scopeOfProject(groupProjectScopes(projects), hostId, projectPath)),
    [chat, hostId, projectPath, projects],
  );
  const environments = useMemo<NewTaskEnvironmentChoice[]>(
    () =>
      chat
        ? hosts.map((candidate) => ({
            hostId: candidate.id,
            label: candidate.label,
            os: candidate.os,
            projectPath: NEW_CHAT_DIRECTORY,
          }))
        : (scope?.projects ?? []).map((project) => ({
            hostId: project.hostId,
            label: project.hostLabel,
            os: hosts.find((candidate) => candidate.id === project.hostId)?.os,
            projectPath: project.project.path,
            subtitle: project.project.path,
          })),
    [chat, hosts, scope],
  );
  return { scope, environments };
}

/**
 * Where the new task runs, pushed in the new-task sheet as T3's Environment
 * screen. Another host moves the draft's text to that host's draft and opens
 * the draft there.
 */
export function NewTaskEnvironmentPickerRouteScreen({ route, navigation }: ScreenProps<"NewTaskEnvironment">) {
  const { hostId, projectPath } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { environments } = useNewTaskEnvironments(hostId, projectPath);
  const select = (choice: NewTaskEnvironmentChoice) => {
    void Haptics.selectionAsync();
    if (choice.hostId === hostId) {
      navigation.goBack();
      return;
    }
    app.saveDraft(choice.hostId, `new-task:${choice.projectPath}`, app.draft(hostId, `new-task:${projectPath}`));
    navigation.popTo("NewTask", { hostId: choice.hostId, projectPath: choice.projectPath });
  };
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android", title: "Host" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Host" hideBottomBorder onBack={() => navigation.goBack()} />
      ) : null}
      <MaterialScreenContent>
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
            {environments.map((environment, index) => (
              <SelectionRow
                key={environment.hostId}
                icon={
                  <EnvironmentMachineSymbol
                    kind={hostMachineKind(environment.os)}
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon-muted"
                  />
                }
                isLast={index === environments.length - 1}
                onPress={() => select(environment)}
                selected={hostId === environment.hostId}
                subtitle={environment.subtitle}
                title={environment.label}
              />
            ))}
          </PickerSurface>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
