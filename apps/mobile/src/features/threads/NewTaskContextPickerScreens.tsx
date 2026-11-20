// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx (MIT, see UPSTREAM.md).
// The Environment and Branch pickers are routes pushed in the new-task sheet, as
// T3; they read the draft from their params instead of a flow provider.
import { isChat, NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
import type { BranchRef } from "@solus/contracts/git-types";
import type { HostOperatingSystem } from "@solus/contracts/types";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialSearchField } from "../../components/MaterialSearchField";
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
import { isDraftThreadRoute } from "./thread-route-state";
import { useNewTaskBalanceCandidates } from "./new-task-balance";
import type { ConversationStore } from "../conversation/conversation-store";
import { branchBadge, selectedBranchName, worktreeBaseChoices } from "./lib/worktree-branches";
import { useWorktreeBranches } from "./use-worktree-branches";

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

export function SelectionRow(props: {
  readonly icon?: ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
  readonly fullLabels?: boolean;
}) {
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.title}
        fullLabels={props.fullLabels}
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
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={props.fullLabels ? undefined : 1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={props.fullLabels ? undefined : 1}>
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
  const { hostId, projectPath, hostChoice } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { environments } = useNewTaskEnvironments(hostId, projectPath);
  const balanceCandidates = useNewTaskBalanceCandidates(environments, null);
  const returnToDraft = (nextHostId: string, nextProjectPath: string, choice?: "manual", balanceRequest?: number) => {
    const draftRoute = navigation.getState().routes.findLast(isDraftThreadRoute);
    const params = { hostId: nextHostId, projectPath: nextProjectPath, hostChoice: choice, balanceRequest };
    if (!draftRoute) {
      navigation.popTo("NewTask", params);
      return;
    }
    navigation.popTo("Thread", {
      hostId: nextHostId,
      sessionId: draftRoute.params.sessionId,
      draft: { ...draftRoute.params.draft, ...params },
    });
  };
  const select = (choice: NewTaskEnvironmentChoice) => {
    void Haptics.selectionAsync();
    if (choice.hostId !== hostId) {
      app.saveDraft(choice.hostId, `new-task:${choice.projectPath}`, app.draft(hostId, `new-task:${projectPath}`));
    }
    returnToDraft(choice.hostId, choice.projectPath, "manual");
  };
  const chooseAutoBalance = () => {
    void Haptics.selectionAsync();
    returnToDraft(hostId, projectPath, undefined, Date.now());
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
            {balanceCandidates.length >= 2 ? (
              <SelectionRow
                icon={<SymbolView name="scalemass" size={Platform.OS === "android" ? 24 : 17} tintColorClassName="accent-icon-muted" />}
                onPress={chooseAutoBalance}
                selected={hostChoice === "auto"}
                title="Auto balance"
              />
            ) : null}
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
                selected={hostChoice !== "auto" && hostId === environment.hostId}
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

/**
 * T3's Branch screen in the new-task sheet: the base of a new worktree, or the
 * branch of the project's checkout. Picking returns to the draft; a checkout
 * branch first waits for the host, which may name another worktree.
 */
export function NewTaskBranchPickerRouteScreen({ route, navigation }: ScreenProps<"NewTaskBranch">) {
  const store = useApp().openConversation(route.params.hostId, route.params.conversationId);
  // A draft closed under the picker leaves nothing to choose for.
  useEffect(() => {
    if (!store) navigation.goBack();
  }, [navigation, store]);
  if (!store) return <View className="flex-1 bg-sheet" />;
  return <NewTaskBranchPicker store={store} onClose={() => navigation.goBack()} />;
}

function NewTaskBranchPicker(props: { readonly store: ConversationStore; readonly onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const searchInput = useRef<TextInputInstance | null>(null);
  const meta = useListened(props.store.meta, props.store.metaSnapshotOf);
  const branchState = useWorktreeBranches(props.store, meta.runOptions.canChooseStart);
  const branches = branchState?.branches ?? null;
  const newWorktree = meta.run.worktreeBaseBranch !== null;
  const currentBranch = branchState?.currentBranch ?? null;
  const selectedBranch = selectedBranchName(branches, newWorktree ? meta.run.worktreeBaseBranch : meta.run.checkoutBranch ?? currentBranch);
  const title = newWorktree ? "Base branch" : "Branch";
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Left during a switch: the draft takes the host's answer; nothing more closes.
  const open = useRef(true);
  useEffect(() => () => { open.current = false; }, []);
  const choices = worktreeBaseChoices(branches ?? [], query);
  const select = async (branch: BranchRef) => {
    void Haptics.selectionAsync();
    if (newWorktree) {
      props.store.controller.chooseWorktreeBase(branch.name);
      props.onClose();
      return;
    }
    setSwitching(branch.name);
    setFailure(null);
    const refusal = await props.store.controller.chooseCheckoutBranch(branch);
    if (!open.current) return;
    setSwitching(null);
    if (refusal) setFailure(refusal);
    else props.onClose();
  };
  const notice = branches === null ? "Loading branches…" : choices.length === 0 ? "No matching branches" : null;
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title,
          headerSearchBarOptions:
            Platform.OS === "ios"
              ? {
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => setQuery(""),
                  onChangeText: (event) => setQuery(event.nativeEvent.text),
                  placeholder: "Find a branch",
                }
              : undefined,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={title} hideBottomBorder onBack={props.onClose} />
      ) : null}
      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            gap: 12,
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {Platform.OS === "android" ? (
            <View className="flex-row">
              <MaterialSearchField
                inputRef={searchInput}
                accessibilityLabel="Find a branch"
                clearAccessibilityLabel="Clear branch search"
                placeholder="Find a branch"
                value={query}
                onChangeText={setQuery}
              />
            </View>
          ) : null}
          {failure ? (
            <Text accessibilityRole="alert" className="px-1 text-sm text-danger-foreground">{failure}</Text>
          ) : null}
          {notice ? (
            <Text className="px-1 text-sm text-foreground-muted">{notice}</Text>
          ) : (
            <PickerSurface>
              {choices.map((branch, index) => (
                <SelectionRow
                  key={branch.name}
                  icon={
                    <SymbolView
                      name="arrow.triangle.branch"
                      size={Platform.OS === "android" ? 24 : 17}
                      tintColorClassName="accent-icon-muted"
                    />
                  }
                  disabled={switching !== null}
                  isLast={index === choices.length - 1}
                  onPress={() => void select(branch)}
                  selected={branch.name === selectedBranch}
                  subtitle={switching === branch.name ? "Switching…" : branchBadge(branch, currentBranch) ?? undefined}
                  title={branch.name}
                />
              ))}
            </PickerSurface>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
