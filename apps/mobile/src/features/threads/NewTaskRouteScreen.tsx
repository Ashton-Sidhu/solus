import { prepareDraftCheckout, type DraftAttachmentSource } from "../../solus/draft-checkout";
import { NEW_CHAT_DIRECTORY, isChat } from "@solus/contracts/chat";
import { sameHostPath } from "@solus/contracts/host-path";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { solus, useSolusWorkspace } from "../../solus/runtime";
import { useListened } from "@solus-mobile/app/app-context";
import { codebasePickerDestinations, type DraftCodebaseContext } from "../../solus/codebase-picker";
import { isDraftThreadRoute } from "./thread-route-state";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { AppBar } from "../../components/ui/AppBar";
import {
  CommonActions,
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  isPickableProjectMember,
  pickableProjectGroups,
} from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { runtimeConnectionErrorText } from "../connection/environmentStatusText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useServerConfigs } from "../../state/entities";
import {
  createNewTaskDraft,
  retargetNewTaskDraft,
  retargetSavedNewTaskDraft,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { MessageResolver } from "../../i18n/messages";

import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { NewTaskCodebaseRows } from "./NewTaskCodebaseRows";

type NewTaskRouteParams = {
  readonly source?: DraftAttachmentSource;
  readonly environmentId?: string;
  readonly currentCodebase?: DraftCodebaseContext;
  readonly incomingShareId?: string | string[];
  /** An existing draft whose project is gone; the chosen project takes it over. */
  readonly draftId?: string | string[];
  readonly prompt?: string | string[];
  readonly repo?: string | string[];
  readonly pr?: string | string[];
  readonly provider?: string | string[];
  readonly model?: string | string[];
};

function deriveProjectEmptyState(
  catalogState: WorkspaceState,
  resolve: MessageResolver,
): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: resolve(msg("Loading environments")),
      detail: resolve(msg("Checking saved environments on this device.")),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: resolve(msg("No environments connected")),
      detail: resolve(msg("Add an environment before creating a task.")),
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? resolve(msg("Client not supported"))
          : resolve(msg("Environment unavailable")),
      detail:
        runtimeConnectionErrorText(catalogState, resolve) ??
        resolve(
          msg(
            "The saved environment is offline. Check the URL or start the environment, then retry.",
          ),
        ),
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: resolve(msg("Connecting to environment")),
      detail: resolve(msg("Loading projects from the saved environment.")),
      loading: true,
    };
  }

  return {
    title: resolve(msg("No projects found")),
    detail: resolve(msg("The connected environment did not report any projects.")),
    loading: false,
  };
}

function NewTaskHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly canAddProject: boolean;
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.getParent()?.goBack();
  };
  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle ?? undefined}
        hideBottomBorder
        onBack={goBack}
        actions={
          props.canAddProject
            ? [
                {
                  accessibilityLabel: gt("Add project"),
                  icon: "plus",
                  onPress: () => navigation.dispatch(StackActions.push("AddProject")),
                },
              ]
            : []
        }
        search={{
          value: props.searchText,
          onChangeText: props.onSearchTextChange,
          placeholder: gt("Search projects and codebases"),
        }}
      />
    </>
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const gt = useGT();
  const m = useMessages();
  const { projects, environments, state: catalogState } = useSolusWorkspace();
  const hostFilter = route.params?.environmentId;
  const current = route.params?.currentCodebase;
  const connectedEnvironments = hostFilter
    ? environments.filter((e) => e.environmentId === hostFilter)
    : environments;
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();

  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const routeDraftId = Array.isArray(route.params?.draftId)
    ? route.params.draftId[0]
    : route.params?.draftId;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? gt("Choose a project for what you shared")
      : incomingShare.attachments.length === 1
        ? incomingShare.attachments[0]?.type === "image"
          ? gt("Choose a project for the image you shared")
          : gt("Choose a project for the file you shared")
        : incomingShare.attachments.every((attachment) => attachment.type === "image")
          ? gt("{count, plural, other {Choose a project for the {count} images you shared}}", {
              count: incomingShare.attachments.length,
            })
          : gt("{count, plural, other {Choose a project for the {count} files you shared}}", {
              count: incomingShare.attachments.length,
            })
    : null;
  const screenTitle = incomingShare ? gt("Start a task") : gt("Choose project or codebase");
  const projectEmptyState = deriveProjectEmptyState(catalogState, m);
  const serverConfigs = useServerConfigs();
  const listScopes = pickableProjectGroups(projectScopes)
    .flatMap((group) => {
      if (!hostFilter) return [group];
      const projects = group.projects.filter(
        (project) => project.environmentId === hostFilter && isPickableProjectMember(project),
      );
      return projects[0] ? [{ ...group, projects, representative: projects[0] }] : [];
    })
    .filter(
      (scope) =>
        !scope.projects.every(
          (project) =>
            isChat(project.workspaceRoot) ||
            isScratchProject(
              project,
              serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot,
            ),
        ),
    );
  const visibleScopes = filterProjectScopes(listScopes, searchText);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;

  const connectedEnvironmentIds = new Set(
    connectedEnvironments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const codebases = useListened(solus.codebases.changes, () => solus.codebases.codebases());
  const hosts = solus.codebases.hosts().filter((host) => !hostFilter || host.hostId === hostFilter);
  const preferredHostId = hostFilter ?? current?.hostId ?? selectedEnvironmentId ??
    connectedEnvironments.find((host) => host.connectionState === "connected")?.environmentId ?? null;
  const query = searchText.trim().toLowerCase();
  const codebaseOptions = codebases.flatMap((codebase) => {
    const destinations = codebasePickerDestinations(codebase, hosts, current);
    if (hostFilter && destinations.length === 0) return [];
    return [{ codebase, destinations }];
  });
  const codebaseRows = codebaseOptions.filter(({ codebase, destinations }) =>
    codebase.name.toLowerCase().includes(query) || destinations.some((host) =>
      host.label.toLowerCase().includes(query) ||
      host.roots.some(({ path }) => path.toLowerCase().includes(query)),
    ),
  );
  const canClearCodebase = current && (!hostFilter || current.hostId === hostFilter) &&
    hosts.some((host) => host.hostId === current.hostId && host.isReady) &&
    (current.codebaseId !== null || solus.codebases.codebasesOfFolder(current.hostId, current.path).length > 1) &&
    gt("No codebase").toLowerCase().includes(query);
  const hasCodebaseRows = codebaseRows.length > 0 || canClearCodebase;
  const hasVisibleRows = visibleScopes.length > 0 || hasCodebaseRows;
  const scratchOption = reservedDestinationProject
    ? null
    : resolveNewTaskScratchOption({
        environments: connectedEnvironments,
        selectedEnvironmentId,
        serverConfigs: new Map(
          connectedEnvironments.map((e) => [
            e.environmentId,
            { scratchWorkspaceRoot: NEW_CHAT_DIRECTORY },
          ]),
        ),
      });
  const canStartScratch = scratchOption?.ready === true;
  const pendingSelection = useRef<AbortController | null>(null);
  const cancelPendingSelection = useCallback(() => {
    pendingSelection.current?.abort();
    pendingSelection.current = null;
  }, []);
  useFocusEffect(useCallback(() => cancelPendingSelection, [cancelPendingSelection]));

  async function selectProject(
    project: EnvironmentProject | Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">,
    signal: AbortSignal,
    codebaseId?: string | null,
  ): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        if (signal?.aborted) return;
        Dialog.alert(
          gt("Could not change project"),
          errorDisplayMessage(error, m) ??
            gt("The shared content reservation could not be updated."),
        );
        return;
      }
      if (signal?.aborted) return;
    }
    const root = navigation.getState()?.routeNames.includes("NewTaskProject")
      ? navigation
      : navigation.getParent();
    const rootState = root?.getState();
    const threadRoute = rootState?.routes[rootState.index - 1];
    if (routeDraftId === undefined && codebaseId === undefined && "title" in project && isDraftThreadRoute(threadRoute)) {
      setProject(project);
      if (root && threadRoute?.key)
        root.dispatch({
          ...CommonActions.setParams({
            draft: { environmentId: project.environmentId, projectId: project.id },
          }),
          source: threadRoute.key,
        });
      root?.goBack();
      return;
    }
    const projectTarget = {
      environmentId: project.environmentId,
      projectId: project.id,
    };
    const target = codebaseId === undefined ? projectTarget : { ...projectTarget, codebaseId };
    if (route.params?.source && routeDraftId) {
      try {
        const threadId = prepareDraftCheckout(
          route.params.source,
          project.environmentId,
          project.workspaceRoot,
        );
        retargetNewTaskDraft(routeDraftId, target);
        selectDetail({
          name: "Thread",
          params: { threadId, draft: { ...projectTarget, draftId: routeDraftId } },
        });
      } catch (error) {
        Dialog.alert(gt("Could not change project"), String(error));
      }
      return;
    }
    // Restamp only on choice, so backing out leaves the draft as it was.
    const retargeted =
      routeDraftId === undefined
        ? false
        : await retargetSavedNewTaskDraft(
            routeDraftId,
            target,
            signal,
          ).then(
            (found) => found,
            () => null,
          );
    if (signal?.aborted) return;
    if (retargeted === null) {
      Dialog.alert(
        gt("Could not change project"),
        gt("Saved drafts could not be loaded. Try again."),
      );
      return;
    }
    const draftId = retargeted ? routeDraftId : codebaseId !== undefined ? createNewTaskDraft(target) : undefined;
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          draftId,
          incomingShareId: incomingShare?.id,
        },
      },
    });
  }

  function chooseProject(project: EnvironmentProject): void {
    const sameProject = current?.hostId === project.environmentId && sameHostPath(current.path, project.workspaceRoot);
    startSelection(project, sameProject && current.codebaseId !== null ? null : undefined);
  }

  function startSelection(project: Parameters<typeof selectProject>[0], codebaseId?: string | null) {
    cancelPendingSelection();
    const request = new AbortController();
    pendingSelection.current = request;
    void selectProject(project, request.signal, codebaseId).finally(() => {
      if (pendingSelection.current === request) pendingSelection.current = null;
    });
  }

  function chooseCodebase(codebaseId: string, hostId: string, path?: string) {
    if (hostFilter && hostFilter !== hostId) return;
    const codebase = solus.codebases.codebaseOf(codebaseId);
    const destination = codebase && codebasePickerDestinations(codebase, solus.codebases.hosts(), current)
      .find((host) => host.hostId === hostId && host.isReady);
    if (!destination) return;
    const folder = path === undefined ? destination.path : destination.roots.find((root) => root.path === path)?.path;
    if (folder) chooseCodebaseFolder(hostId, folder, codebaseId);
  }

  function chooseCodebaseFolder(hostId: string, path: string, codebaseId: string | null) {
    startSelection({
      environmentId: EnvironmentId.make(hostId),
      id: ProjectId.make(path),
      workspaceRoot: path,
    }, codebaseId);
  }

  async function startScratch(): Promise<void> {
    if (!canStartScratch || !scratchOption || pendingSelection.current) return;
    const environmentId = scratchOption.environmentId;
    const request = new AbortController();
    pendingSelection.current = request;
    try {
      await waitForComposerDraftsLoaded();
      if (request.signal.aborted) return;
      const now = new Date().toISOString();
      await selectProject(
        {
          environmentId,
          id: ProjectId.make(NEW_CHAT_DIRECTORY),
          title: gt("No project"),
          workspaceRoot: NEW_CHAT_DIRECTORY,
          defaultModelSelection: null,
          repositoryIdentity: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
        request.signal,
      );
    } catch (error) {
      if (!request.signal.aborted)
        Dialog.alert(
          gt("Could not start without a project"),
          errorDisplayMessage(error, m) ?? String(error),
        );
    } finally {
      if (pendingSelection.current === request) pendingSelection.current = null;
    }
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates to the incoming share's reserved destination draft once its project loads and the screen is focused
  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Reset on return so reserved-draft resume can retry without leaving project rows disabled.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: reservedDestinationProject.environmentId,
          projectId: reservedDestinationProject.id,
          title: reservedDestinationProject.title,
          incomingShareId: incomingShare.id,
        },
      },
    });
  }, [incomingShare, isFocused, reservedDestinationProject, selectDetail]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title={screenTitle}
        subtitle={incomingShareSubtitle}
        canAddProject={catalogState.hasReadyEnvironment}
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && !hasVisibleRows
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {scratchOption !== null && (listScopes.length > 0 || codebaseOptions.length > 0) ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <NavigationRow
                  className="bg-grouped-card"
                  title={gt("No project")}
                  subtitle={gt("Start a task without a project")}
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  leading={
                    <SymbolView
                      name="text.bubble"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("No project")}
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  className={cn(
                    "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
                    !canStartScratch && "opacity-45",
                  )}
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="text.bubble"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">
                      <T>No project</T>
                    </Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      <T>Start a task without a project</T>
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
          {hasCodebaseRows ? (
            <NewTaskCodebaseRows
              rows={codebaseRows}
              preferredHostId={preferredHostId}
              currentCodebaseId={current?.codebaseId ?? null}
              disabled={reservedDestinationProject !== null}
              onChoose={chooseCodebase}
              onClear={canClearCodebase && current
                ? () => chooseCodebaseFolder(current.hostId, current.path, null)
                : undefined}
            />
          ) : null}
          {listScopes.length === 0 && codebaseOptions.length === 0 && !hasCodebaseRows ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {projectEmptyState.loading ? (
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <View>
                    <Button
                      label={
                        catalogState.hasReadyEnvironment
                          ? gt("Add new project")
                          : gt("Add environment")
                      }
                      tone="primary"
                      onPress={() =>
                        catalogState.hasReadyEnvironment
                          ? navigation.dispatch(StackActions.push("AddProject"))
                          : navigation.navigate("ConnectionsNew")
                      }
                    />
                  </View>
                  {canStartScratch ? (
                    <View>
                      <Button
                        label={gt("Start without a project")}
                        tone="secondary"
                        onPress={() => void startScratch()}
                      />
                    </View>
                  ) : null}
                </>
              ) : !catalogState.hasReadyEnvironment ? (
                <View className="mt-1">
                  <Button
                    label={gt("Add environment")}
                    tone="primary"
                    onPress={() => navigation.navigate("ConnectionsNew")}
                  />
                </View>
              ) : (
                <>
                  <View className="mt-1">
                    <Button
                      label={gt("Add new project")}
                      tone="primary"
                      onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                    />
                  </View>
                  {canStartScratch ? (
                    <View>
                      <Button
                        label={gt("Start without a project")}
                        tone="secondary"
                        onPress={() => void startScratch()}
                      />
                    </View>
                  ) : null}
                </>
              )}
            </View>
          ) : !hasVisibleRows ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                <T>No matching projects or codebases</T>
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                <T>Try a different name or folder path.</T>
              </Text>
            </View>
          ) : visibleScopes.length > 0 ? (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const selectionTarget = getProjectScopeSelectionTarget(
                  scope,
                  selectedEnvironmentId,
                  connectedEnvironmentIds,
                );
                if (Platform.OS === "android") {
                  return (
                    <NavigationRow
                      className="bg-grouped-card"
                      key={scope.key}
                      title={scope.title}
                      subtitle={
                        hasMultipleProjects
                          ? gt("{count, plural, other {{count} workspaces}}", {
                              count: scope.projects.length,
                            })
                          : selectionTarget.workspaceRoot
                      }
                      subtitleNumberOfLines={1}
                      subtitleEllipsizeMode="middle"
                      disabled={reservedDestinationProject !== null}
                      onPress={() => chooseProject(selectionTarget)}
                      leading={
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={24}
                          projectTitle={scope.representative.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      }
                    />
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      disabled={reservedDestinationProject !== null}
                      onPress={() => chooseProject(selectionTarget)}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={20}
                          projectTitle={scope.representative.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {hasMultipleProjects
                            ? gt("{count, plural, other {{count} workspaces}}", {
                                count: scope.projects.length,
                              })
                            : selectionTarget.workspaceRoot}
                        </Text>
                      </View>
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : null}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
