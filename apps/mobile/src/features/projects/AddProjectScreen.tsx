import { createProject, cloneProject, addLocalProject, addCodebaseFolder, makeCodebase, useProjectHosts, browseProjectFolders } from "../../solus/project-host";
import { plainCodebaseName } from "@solus/contracts/codebases";
import { hostPathBaseName } from "@solus/contracts/host-path";
import { useEnvironmentQuery } from "../../state/query";
import { useCheckoutAccess } from "../../solus/use-checkout-files";
import { solus, useSolusWorkspace } from "../../solus/runtime";
import { errorDisplayMessage, type MarkedText } from "@t3tools/client-runtime/errors";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Button } from "../../components/ui/Button";
import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  canCreateProjectInEnvironment,
  getAddProjectInitialQuery,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryPath,
  getCloneDirectoryName,
  getNewProjectPathPreview,
  githubIncompleteOwnerRepositoryMessage,
  defaultHostCloneUrl,
  normalizePastedCloneUrl,
  parseAddProjectRemoteSource,
  resolveAddProjectPath,
  type OfferedSourceControlProviders,
  type AddProjectRemoteSource,
} from "@t3tools/client-runtime/operations/projects";
import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  inferProjectTitleFromPath,
  isWindowsPlatform,
} from "@t3tools/client-runtime/state/projects";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  ProjectId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  StackActions,
  useNavigation,
  type NavigationState,
  type ParamListBase,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { msg, useGT, useMessages } from "gt-react-native";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { m } from "../../i18n/messages";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { SourceControlIcon } from "./SourceControlIcon";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { resolveAddProjectEnvironment } from "./AddProjectScreen.logic";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platform: string;
  readonly machine: EnvironmentMachineKind;
  readonly baseDirectory: string | null;
  readonly newProjectsRoot: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly i18nConnectionError?: MarkedText;
  readonly connectionErrorTraceId: string | null;
  readonly canPublish: boolean;
  readonly ghqCloneLayout: boolean;
  readonly offeredSourceControlProviders: OfferedSourceControlProviders | undefined;
}

function platformFromOs(os: string | null | undefined): string {
  if (os === "windows" || os === "win32") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && errorDisplayMessage(error, m) !== null
    ? (errorDisplayMessage(error, m) ?? error.message)
    : m(msg("An error occurred."));
}

function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function sourceFromParam(value: string | string[] | undefined): AddProjectRemoteSource {
  return parseAddProjectRemoteSource(stringParam(value));
}

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text
      className={
        Platform.OS === "android"
          ? "px-4 text-sm font-t3-medium text-primary-text"
          : "px-1 text-2xs font-t3-bold tracking-[0.7px] uppercase text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}

function AddProjectShell(props: { readonly children: ReactNode; readonly title: string }) {
  const insets = useSafeAreaInsets();

  return (
    // A collapsible wrapper lets formSheet resizing mistake the full-height view for a header and collapse the ScrollView.
    <SettingsScreen title={props.title}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: Platform.OS === "android" ? 16 : 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: Platform.OS === "android" ? 16 : 10,
        }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

function ListSection(props: { readonly children: ReactNode }) {
  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-[24px] bg-grouped-card"
      }
    >
      {props.children}
    </View>
  );
}

function EnvironmentOptionRow(
  props: Omit<Parameters<typeof ListRow>[0], "subtitle"> & {
    readonly environment: EnvironmentOption;
  },
) {
  const { environment, ...row } = props;
  const messages = useMessages();
  return (
    <ListRow
      {...row}
      subtitle={
        canCreateProjectInEnvironment(environment.connectionState)
          ? undefined
          : connectionStatusText(
              {
                phase: environment.connectionState,
                error: environment.connectionError,
                ...(environment.i18nConnectionError === undefined
                  ? {}
                  : { i18nError: environment.i18nConnectionError }),
                traceId: environment.connectionErrorTraceId,
              },
              messages,
            )
      }
    />
  );
}

function ListRow(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly isFirst?: boolean;
  readonly right?: ReactNode;
  readonly onPress?: () => void;
}) {
  if (Platform.OS === "android") {
    return (
      <NavigationRow
        className="bg-grouped-card"
        title={props.title}
        subtitle={props.subtitle}
        leading={props.icon}
        trailing={props.right}
        disabled={props.disabled}
        onPress={props.onPress}
        accessibilityRole={props.selected !== undefined ? "radio" : "button"}
        accessibilityState={props.selected !== undefined ? { checked: props.selected } : undefined}
      />
    );
  }
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "bg-grouped-card px-3.5 py-2.5 active:opacity-70",
        !props.isFirst && "border-t border-border-subtle",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <View className="flex-row items-center gap-3">
        <View
          className={
            props.selected
              ? "h-7 w-7 items-center justify-center rounded-full bg-primary"
              : "h-7 w-7 items-center justify-center"
          }
        >
          {props.icon}
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-base leading-snug font-t3-bold">{props.title}</Text>
          {props.subtitle ? (
            <Text className="text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {"right" in props ? (
          props.right
        ) : !props.disabled ? (
          <SymbolView
            name="chevron.right"
            size={13}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function PrimaryActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  return <Button {...props} tone="primary" fullWidth />;
}

function ProjectPathInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <TextInput
      className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
      value={props.value}
      onChangeText={(text) => props.onChangeText(resolvePastedPath(props.value, text))}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder="~/projects/my-app"
      returnKeyType="done"
      onSubmitEditing={props.onSubmit}
    />
  );
}

function useBrowsePathInput(
  environment: EnvironmentOption | null,
  pinnedDirectoryName = "",
  cloneDirectoryPath = pinnedDirectoryName,
) {
  const environmentId = environment?.environmentId ?? null;
  const environmentBaseDirectory = environment?.baseDirectory ?? null;
  const clonePathCaseSensitive = !isWindowsPlatform(environment?.platform ?? "");
  const seedPath = getCloneDestinationPath(
    getAddProjectInitialQuery(environmentBaseDirectory),
    cloneDirectoryPath,
  );
  // Each host keeps the path last typed or browsed for it, and shows its own default until then,
  // so switching hosts and back loses nothing. With no host selected (one dropping out briefly),
  // the field keeps the last path typed anywhere.
  const [paths, setPaths] = useState<{
    readonly byHost: ReadonlyMap<EnvironmentId, string>;
    readonly last: string;
  }>(() => ({ byHost: new Map(), last: seedPath }));
  const pathInput =
    environmentId === null ? paths.last : (paths.byHost.get(environmentId) ?? seedPath);
  const commitPathInput = (path: string) =>
    setPaths((current) => {
      const byHost = new Map(current.byHost);
      if (environmentId !== null) {
        byHost.set(environmentId, path);
      }
      return { byHost, last: path };
    });
  const setPathInput = commitPathInput;
  const navigateToBrowsePath = (input: {
    browseDirectoryPath: string;
    selectedDirectoryName?: string;
  }) => {
    const selectedDirectoryPath = input.selectedDirectoryName
      ? appendBrowsePathSegment(input.browseDirectoryPath, input.selectedDirectoryName)
      : input.browseDirectoryPath;
    const nextPathInput =
      pinnedDirectoryName && input.selectedDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: input.browseDirectoryPath,
            selectedDirectoryName: input.selectedDirectoryName,
            cloneDirectoryName: pinnedDirectoryName,
            caseSensitive: clonePathCaseSensitive,
          })
        : getCloneDestinationPath(selectedDirectoryPath, pinnedDirectoryName);
    commitPathInput(nextPathInput);
  };
  return { pathInput, setPathInput, navigateToBrowsePath };
}

function useEnvironmentOptions(
  selectedEnvironmentId: EnvironmentId | null = null,
): ReadonlyArray<EnvironmentOption> {
  const { environments } = useSolusWorkspace();
  const facts = useProjectHosts(environments.filter((e) => e.connectionState === "connected").map((e) => e.environmentId));
  return environments
    .filter((e) => e.connectionState === "connected" || e.environmentId === selectedEnvironmentId)
    .map((e) => {
      const host = facts.get(e.environmentId);
      return {
        ...e,
        label: e.environmentLabel,
        machine: resolveEnvironmentMachineKind(null),
        platform: platformFromOs(host?.platform),
        baseDirectory: host?.projectsRoot ?? null,
        newProjectsRoot: host?.projectsRoot ?? null,
        canPublish:
          !!(host?.github.solusToken || host?.github.ghAuthenticated) &&
          solus.connections.may(e.environmentId, "host.git.write"),
        ghqCloneLayout: false,
        offeredSourceControlProviders: undefined,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function useSelectedEnvironment(requestedEnvironmentId: EnvironmentId | null): {
  readonly environmentOptions: ReadonlyArray<EnvironmentOption>;
  readonly selectedEnvironment: EnvironmentOption | null;
  readonly setSelectedEnvironmentId: (environmentId: EnvironmentId) => void;
} {
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(requestedEnvironmentId);
  const [previousRequest, setPreviousRequest] = useState(requestedEnvironmentId);
  if (previousRequest !== requestedEnvironmentId) {
    setPreviousRequest(requestedEnvironmentId);
    setSelectedEnvironmentId(requestedEnvironmentId);
  }
  const environmentOptions = useEnvironmentOptions(selectedEnvironmentId);
  const selectedEnvironment =
    environmentOptions.find((environment) => environment.environmentId === selectedEnvironmentId) ??
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ??
    null;

  return {
    environmentOptions,
    selectedEnvironment,
    setSelectedEnvironmentId,
  };
}

function EmptyEnvironmentState() {
  const navigation = useNavigation();
  const gt = useGT();

  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-5 py-8">
      <Text className="text-center text-lg font-t3-bold">{gt("Environment unavailable")}</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        {gt("Start or reconnect an environment before adding a project.")}
      </Text>
      <View className="mt-1">
        <Button
          label={gt("Add environment")}
          tone="primary"
          onPress={() => navigation.dispatch(StackActions.replace("ConnectionsNew"))}
        />
      </View>
    </View>
  );
}

function SourceControlRow(props: {
  readonly source: AddProjectRemoteSource;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly ready: boolean;
  readonly hint: string;
  readonly isFirst: boolean;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const messages = useMessages();
  const title =
    props.source === "url"
      ? gt("Git URL")
      : gt("{provider} repository", {
          provider: addProjectRemoteSourceLabel(props.source, messages),
        });
  const subtitle =
    props.source === "url"
      ? gt("Clone from a remote URL")
      : gt("Clone {provider} {hint}", {
          provider: addProjectRemoteSourceLabel(props.source, messages),
          hint: props.hint,
        });
  const icon =
    props.source === "url" ? (
      <SymbolView
        name="link"
        size={Platform.OS === "android" ? 24 : 17}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    ) : (
      <SourceControlIcon
        icon={sourceControlClients.get(props.source).icon}
        size={Platform.OS === "android" ? 24 : 18}
        colorClassName="accent-icon"
      />
    );

  if (!props.ready) {
    return (
      <ListRow title={title} subtitle={props.hint} icon={icon} disabled isFirst={props.isFirst} />
    );
  }

  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      icon={icon}
      isFirst={props.isFirst}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("AddProjectRepository", {
            environmentId: props.selectedEnvironmentId,
            source: props.source,
          }),
        )
      }
    />
  );
}

export function AddProjectSourceScreen(props: { readonly environmentId?: string | string[] }) {
  const navigation = useNavigation();
  const { environmentOptions, selectedEnvironment, setSelectedEnvironmentId } =
    useSelectedEnvironment(stringParam(props.environmentId) as EnvironmentId | null);
  const isConnected = canCreateProjectInEnvironment(selectedEnvironment?.connectionState);
  const canCloneProject = isConnected;
  const canCreateProject = isConnected;
  const messages = useMessages();
  const readiness = (source: AddProjectRemoteSource) => ({
    ready: source === "url" || source === "github",
    hint: "",
  });
  const gt = useGT();

  return (
    <AddProjectShell title={gt("Add project")}>
      {selectedEnvironment === null ? <EmptyEnvironmentState /> : null}

      {environmentOptions.length > 1 || (selectedEnvironment !== null && !isConnected) ? (
        <>
          <SectionTitle>{gt("Environments")}</SectionTitle>
          <ListSection>
            {environmentOptions.map((environment, index) => (
              <EnvironmentOptionRow
                key={environment.environmentId}
                environment={environment}
                title={environment.label}
                icon={
                  <EnvironmentMachineSymbol
                    kind={environment.machine}
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon"
                  />
                }
                selected={environment.environmentId === selectedEnvironment?.environmentId}
                disabled={!canCreateProjectInEnvironment(environment.connectionState)}
                isFirst={index === 0}
                right={
                  environment.environmentId === selectedEnvironment?.environmentId ? (
                    <SymbolView
                      name="checkmark"
                      size={Platform.OS === "android" ? 20 : 14}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  ) : null
                }
                onPress={() => setSelectedEnvironmentId(environment.environmentId)}
              />
            ))}
          </ListSection>
        </>
      ) : null}

      {selectedEnvironment ? (
        <>
          <ListSection>
            {selectedEnvironment.newProjectsRoot !== null ? (
              <ListRow
                title={gt("New project")}
                subtitle={gt("Start a new Git repository from a name")}
                disabled={!isConnected}
                icon={
                  <SymbolView
                    name="plus"
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                }
                isFirst
                onPress={() =>
                  navigation.dispatch(
                    StackActions.push("AddProjectNew", {
                      environmentId: selectedEnvironment.environmentId,
                    }),
                  )
                }
              />
            ) : null}
            <ListRow
              title={gt("Local folder")}
              subtitle={
                canCreateProject
                  ? gt("Browse a folder on disk")
                  : gt("This connection cannot add projects.")
              }
              icon={
                <SymbolView
                  name="folder.badge.plus"
                  size={Platform.OS === "android" ? 24 : 17}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              }
              isFirst={selectedEnvironment.newProjectsRoot === null}
              disabled={!isConnected || !canCreateProject}
              onPress={() =>
                navigation.dispatch(
                  StackActions.push("AddProjectLocal", {
                    environmentId: selectedEnvironment.environmentId,
                  }),
                )
              }
            />
            {(["url", "github"] as AddProjectRemoteSource[]).map((candidate) => (
              <SourceControlRow
                key={candidate}
                source={candidate}
                selectedEnvironmentId={selectedEnvironment.environmentId}
                ready={canCloneProject && readiness(candidate).ready}
                hint={
                  !canCloneProject
                    ? gt("This connection cannot clone projects.")
                    : readiness(candidate).ready
                      ? addProjectRemoteSourcePathHint(candidate, messages)
                      : (readiness(candidate).hint ?? "")
                }
                isFirst={false}
              />
            ))}
          </ListSection>
        </>
      ) : null}
    </AddProjectShell>
  );
}

function getActiveRoute(navigation: {
  getState: () => NavigationState<ParamListBase> | undefined;
}) {
  const state = navigation.getState();
  return state?.routes[state.index];
}

function useOpenNewTaskDraft() {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const selectDetail = useSelectWorkspaceDetail();
  return (
    params: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      title: string;
      cloning?: "1";
      draftId?: string;
    },
    originRoute: NavigationState<ParamListBase>["routes"][number] | undefined,
  ) => {
    const activeRoute = getActiveRoute(navigation);
    // A warm link can change the task without replacing its native route key.
    if (
      !originRoute ||
      activeRoute?.key !== originRoute.key ||
      activeRoute.name !== originRoute.name ||
      activeRoute.params !== originRoute.params
    )
      return;
    selectDetail({ name: "Thread", params: { draft: params } });
  };
}

async function draftWithPrompt(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  prompt: string,
): Promise<string> {
  await waitForComposerDraftsLoaded();
  const draftId = createNewTaskDraft({ environmentId, projectId });
  setComposerDraftText(draftId, prompt);
  return draftId;
}

function useEnvironmentFromParam(
  environmentIdParam: string | string[] | undefined,
): EnvironmentOption | null {
  const environmentOptions = useEnvironmentOptions();
  const environmentId = stringParam(environmentIdParam) as EnvironmentId | null;
  return resolveAddProjectEnvironment(environmentOptions, environmentId);
}

export function AddProjectRepositoryScreen(props: {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
}) {
  const navigation = useNavigation();
  const environment = useEnvironmentFromParam(props.environmentId);
  const source = sourceFromParam(props.source);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();
  const messages = useMessages();

  const lookupRepository = async () => {
    if (!environment || repositoryInput.trim().length === 0 || isSubmitting) return;
    const incompleteOwnerMessage = githubIncompleteOwnerRepositoryMessage(
      source,
      repositoryInput,
      m,
    );
    if (incompleteOwnerMessage) {
      setError(incompleteOwnerMessage);
      return;
    }
    setError(null);
    setIsSubmitting(true);
    const provider = addProjectRemoteSourceProvider(source);
    if (!provider) {
      const remoteUrl = normalizePastedCloneUrl(repositoryInput);
      navigation.dispatch(
        StackActions.push("AddProjectDestination", {
          environmentId: environment.environmentId,
          source,
          remoteUrl,
          repositoryTitle: remoteUrl,
          repositoryName: getCloneDirectoryName(remoteUrl),
        }),
      );
      setIsSubmitting(false);
      return;
    }

    const slug = repositoryInput
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git\/?$|\/$/g, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
      setError(gt("Enter a GitHub repository as owner/name."));
    } else {
      navigation.dispatch(
        StackActions.push("AddProjectDestination", {
          environmentId: environment.environmentId,
          source,
          remoteUrl: "https://github.com/" + slug + ".git",
          repositoryTitle: slug,
          repositoryName: getCloneDirectoryName(slug),
        }),
      );
    }
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell
      title={source === "url" ? gt("Git URL") : addProjectRemoteSourceLabel(source, messages)}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <TextInput
            className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
            value={repositoryInput}
            onChangeText={setRepositoryInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={
              source === "url"
                ? (defaultHostCloneUrl("org/repo") ?? "https://example.com/org/repo.git")
                : addProjectRemoteSourcePathHint(source, messages)
            }
            returnKeyType="next"
            onSubmitEditing={() => void lookupRepository()}
          />
          <PrimaryActionButton
            label={source === "url" ? gt("Continue") : gt("Lookup repository")}
            disabled={isSubmitting || repositoryInput.trim().length === 0}
            onPress={() => void lookupRepository()}
            loading={isSubmitting}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

function FolderBrowser(props: {
  readonly environment: EnvironmentOption;
  readonly pathInput: string;
  readonly setPathInput: (path: string) => void;
  readonly navigateToBrowsePath: (input: {
    readonly browseDirectoryPath: string;
    readonly selectedDirectoryName?: string;
  }) => void;
  readonly pinnedDirectoryName?: string;
  readonly cloning?: boolean;
}) {
  const browsePath = getFilesystemBrowsePath(props.pathInput, props.environment.platform);
  const browseInput =
    browsePath.directoryPath.length > 0 ? { partialPath: browsePath.directoryPath } : null;
  const hostId = props.environment.environmentId;
  const access = useCheckoutAccess(hostId);
  const browseState = useEnvironmentQuery(
    access.canReadFiles && browseInput ? browseProjectFolders({ environmentId: hostId, input: browseInput }) : null,
  );
  const pinnedDirectoryName = props.pinnedDirectoryName ?? "";
  const pinnedDirectoryMatches = isWindowsPlatform(props.environment.platform)
    ? browsePath.filterQuery.toLowerCase() === pinnedDirectoryName.toLowerCase()
    : browsePath.filterQuery === pinnedDirectoryName;
  const browseFilterQuery = pinnedDirectoryMatches ? "" : browsePath.filterQuery;
  const { visibleEntries: visibleBrowseEntries } = filterFilesystemBrowseEntries(
    browseState.data?.entries ?? [],
    browseFilterQuery,
  );
  const gt = useGT();

  return (
    <>
      <SectionTitle>{gt("Browse folders")}</SectionTitle>
      {!access.canReadFiles && !access.isPending ? <ErrorBanner message={access.error ?? gt("This connection cannot browse host folders.")} /> : null}
      {browseState.error ? <ErrorBanner message={browseState.error} /> : null}
      <ListSection>
        {access.isPending || (browseState.isPending && browseState.data === null) ? (
          <View className="items-center py-5">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : null}
        {browsePath.canBrowseUp ? (
          <ListRow
            title=".."
            icon={
              <SymbolView
                name="arrow.turn.left.up"
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            }
            isFirst
            right={null}
            onPress={() => {
              if (browsePath.parentPath) {
                void props.navigateToBrowsePath({
                  browseDirectoryPath: browsePath.parentPath,
                });
              }
            }}
          />
        ) : null}
        {visibleBrowseEntries.map((entry, index) => (
          <ListRow
            key={entry.fullPath}
            title={entry.name}
            icon={
              <SymbolView
                name="folder"
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            }
            isFirst={index === 0 && !browsePath.canBrowseUp}
            right={null}
            onPress={() => {
              void props.navigateToBrowsePath({
                browseDirectoryPath: browsePath.directoryPath,
                selectedDirectoryName: entry.name,
              });
            }}
          />
        ))}
      </ListSection>
    </>
  );
}

export function AddProjectNewScreen(props: { readonly environmentId?: string | string[] }) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const environmentOptions = useEnvironmentOptions().filter(
    (option) => option.newProjectsRoot !== null,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    () => stringParam(props.environmentId) as EnvironmentId | null,
  );
  const environment = resolveAddProjectEnvironment(environmentOptions, selectedEnvironmentId);
  const [name, setName] = useState("");
  const [publishes, setPublishes] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const gt = useGT();
  const pathPreview =
    environment?.newProjectsRoot != null
      ? getNewProjectPathPreview(environment.newProjectsRoot, trimmedName)
      : null;

  const showMachines =
    environmentOptions.length > 1 || (environment === null && environmentOptions.length > 0);
  const machineRows = showMachines ? (
    <ListSection>
      {environmentOptions.map((option, index) => {
        const selected = option.environmentId === environment?.environmentId;
        return (
          <ListRow
            key={option.environmentId}
            title={option.label}
            icon={
              <EnvironmentMachineSymbol
                kind={option.machine}
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon"
              />
            }
            selected={selected}
            disabled={isSubmitting}
            isFirst={index === 0}
            right={
              selected ? (
                <SymbolView
                  name="checkmark"
                  size={Platform.OS === "android" ? 20 : 14}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              ) : null
            }
            onPress={() => setSelectedEnvironmentId(option.environmentId)}
          />
        );
      })}
    </ListSection>
  ) : null;

  // State lags a render behind, so a double tap could start a second create.
  const submittingRef = useRef(false);
  const submit = async () => {
    if (!environment || trimmedName.length === 0 || submittingRef.current) return;
    const originRoute = getActiveRoute(navigation);
    submittingRef.current = true;
    setError(null);
    setIsSubmitting(true);
    try {
      const { project, publishError } = await createProject(environment.environmentId, trimmedName, publishes && environment.canPublish);
      if (publishError) Dialog.alert(gt("Project created"), errorMessage(publishError));
      openNewTaskDraft(
        {
          environmentId: environment.environmentId,
          projectId: ProjectId.make(project.path),
          title: trimmedName,
        },
        originRoute,
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <AddProjectShell title={gt("New project")}>
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <TextInput
            className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
            value={name}
            onChangeText={setName}
            autoCorrect={false}
            autoFocus
            placeholder={gt("Project name")}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          {pathPreview !== null ? (
            <Text className="px-1 text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {trimmedName.length > 0
                ? showMachines
                  ? gt("Creates {path} on {environment}", {
                      path: pathPreview,
                      environment: environment.label,
                    })
                  : gt("Creates {path}", { path: pathPreview })
                : showMachines
                  ? gt("Goes in {path} on {environment}", {
                      path: environment.newProjectsRoot,
                      environment: environment.label,
                    })
                  : gt("Goes in {path}", { path: environment.newProjectsRoot })}
            </Text>
          ) : null}
          {machineRows}
          {environment.canPublish && (
            <ListSection>
              <ListRow
                isFirst
                title={gt("Create private repository on {provider}", { provider: "GitHub" })}
                icon={
                  <SourceControlIcon
                    icon={sourceControlClients.get("github").icon}
                    size={18}
                    colorClassName="accent-icon"
                  />
                }
                right={
                  <ThemedSwitch
                    accessibilityLabel={gt("Create private repository on {provider}", {
                      provider: "GitHub",
                    })}
                    value={publishes}
                    onValueChange={setPublishes}
                  />
                }
                onPress={() => setPublishes((value) => !value)}
              />
            </ListSection>
          )}
          <PrimaryActionButton
            label={gt("Create project")}
            disabled={isSubmitting || trimmedName.length === 0}
            onPress={() => void submit()}
            loading={isSubmitting}
          />
          <ListSection>
            <ListRow
              title={gt("Add existing project")}
              subtitle={gt("Open a folder or clone a repository")}
              icon={
                <SymbolView
                  name="folder.badge.plus"
                  size={Platform.OS === "android" ? 24 : 17}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              }
              isFirst
              onPress={() =>
                navigation.canGoBack()
                  ? navigation.goBack()
                  : navigation.dispatch(StackActions.replace("AddProject"))
              }
            />
          </ListSection>
        </>
      ) : environmentOptions.length > 0 ? (
        machineRows
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

export function AddProjectLocalFolderScreen(props: {
  readonly environmentId?: string | string[];
  readonly codebaseId?: string | string[];
  readonly codebaseWith?: string | string[];
}) {
  const environment = useEnvironmentFromParam(props.environmentId);
  // Solus: with a codebase, the chosen folder becomes a root of it and no project is added.
  const codebaseId = stringParam(props.codebaseId);
  // Solus: with the first folder of a new codebase, the chosen folder is its second folder, and the codebase is made.
  const codebaseWith = stringParam(props.codebaseWith);
  const addsFolder = codebaseId !== null || codebaseWith !== null;
  const canCreateProject = environment?.connectionState === "connected";
  const navigation = useNavigation();
  const openNewTaskDraft = useOpenNewTaskDraft();
  const { navigateToBrowsePath, pathInput, setPathInput } = useBrowsePathInput(environment);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();

  const submitPath = async () => {
    if (!environment || isSubmitting) return;
    setError(null);
    const resolved = resolveAddProjectPath(
      {
        rawPath: pathInput,
        currentProjectCwd: null,
        platform: environment.platform,
      },
      m,
    );
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }

    if (codebaseWith !== null) {
      const environmentId = environment.environmentId;
      Dialog.prompt({
        title: gt("Codebase name"),
        // The name that Solus gives a codebase of these two folders: the person can change it.
        initialValue: plainCodebaseName([
          hostPathBaseName(codebaseWith),
          hostPathBaseName(resolved.path),
        ]),
        confirmText: gt("Make", { $context: "verb, makes a new codebase" }),
        onConfirm: (name) => {
          setIsSubmitting(true);
          void makeCodebase(environmentId, name, [codebaseWith, resolved.path])
            .then(
              () => navigation.goBack(),
              (failure) => setError(errorMessage(failure)),
            )
            .then(() => setIsSubmitting(false));
        },
      });
      return;
    }

    setIsSubmitting(true);
    const originRoute = getActiveRoute(navigation);
    try {
      if (codebaseId !== null) {
        await addCodebaseFolder(environment.environmentId, codebaseId, resolved.path);
        setIsSubmitting(false);
        navigation.goBack();
        return;
      }
      const project = await addLocalProject(environment.environmentId, resolved.path);
      if (project)
        openNewTaskDraft(
          { environmentId: environment.environmentId, projectId: project.id, title: project.title },
          originRoute,
        );
      else
        Dialog.alert(
          gt("Project added"),
          gt(
            "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
          ),
        );
    } catch (error) {
      setError(errorMessage(error));
    }
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell
      title={
        codebaseWith !== null
          ? gt("Second folder")
          : codebaseId !== null
            ? gt("Add folder")
            : gt("Local folder")
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          {!canCreateProject ? (
            <ErrorBanner
              message={
                addsFolder
                  ? gt("This connection cannot add folders.")
                  : gt("This connection cannot add projects.")
              }
            />
          ) : null}
          <ProjectPathInput value={pathInput} onChangeText={setPathInput} onSubmit={submitPath} />
          <PrimaryActionButton
            label={
              codebaseWith !== null
                ? gt("Make codebase")
                : codebaseId !== null
                  ? gt("Add folder")
                  : gt("Add project")
            }
            disabled={!canCreateProject || isSubmitting}
            onPress={submitPath}
            loading={isSubmitting}
          />
          <FolderBrowser
            environment={environment}
            navigateToBrowsePath={navigateToBrowsePath}
            pathInput={pathInput}
            setPathInput={setPathInput}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

export function AddProjectDestinationScreen(props: {
  readonly environmentId?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repositoryTitle?: string | string[];
  readonly repositoryName?: string | string[];
  readonly prompt?: string | string[];
}) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const environment = useEnvironmentFromParam(props.environmentId);
  const canCloneProject = environment?.connectionState === "connected";
  const remoteUrl = stringParam(props.remoteUrl);
  const repositoryTitle = stringParam(props.repositoryTitle);
  const prompt = stringParam(props.prompt);
  const repositoryName = stringParam(props.repositoryName)?.trim() ?? "";
  const ghqDirectoryPath =
    remoteUrl && environment?.ghqCloneLayout
      ? getCloneDirectoryPath(remoteUrl, true, repositoryName)
      : null;
  const cloneDirectoryName = ghqDirectoryPath?.split("/").at(-1) ?? repositoryName;
  const { navigateToBrowsePath, pathInput, setPathInput } = useBrowsePathInput(
    environment,
    cloneDirectoryName,
    ghqDirectoryPath ?? repositoryName,
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gt = useGT();

  const submitPath = async () => {
    if (!environment || !canCloneProject || !remoteUrl || isSubmitting) {
      return;
    }
    setError(null);
    const resolved = resolveAddProjectPath(
      {
        rawPath: pathInput,
        currentProjectCwd: null,
        platform: environment.platform,
      },
      m,
    );
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }

    const originRoute = getActiveRoute(navigation);
    setIsSubmitting(true);
    try {
      const project = await cloneProject(environment.environmentId, remoteUrl, resolved.path);
      const projectId = ProjectId.make(project.path);
      openNewTaskDraft(
        {
          environmentId: environment.environmentId,
          projectId,
          title: inferProjectTitleFromPath(project.path),
          ...(prompt
            ? { draftId: await draftWithPrompt(environment.environmentId, projectId, prompt) }
            : {}),
        },
        originRoute,
      );
    } catch (error) {
      setError(errorMessage(error));
    }
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell title={gt("Clone destination")}>
      {error ? <ErrorBanner message={error} /> : null}
      {repositoryTitle ? (
        <View className="rounded-[24px] bg-grouped-card px-4 py-3">
          <Text className="text-base font-t3-bold">{repositoryTitle}</Text>
          <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={2}>
            {remoteUrl}
          </Text>
        </View>
      ) : null}
      {environment ? (
        <>
          <ProjectPathInput value={pathInput} onChangeText={setPathInput} onSubmit={submitPath} />
          <PrimaryActionButton
            label={gt("Clone project")}
            disabled={!canCloneProject || isSubmitting || !remoteUrl}
            onPress={submitPath}
            loading={isSubmitting}
          />
          {!canCloneProject ? (
            <Text className="text-sm text-foreground-muted">
              {gt("This connection cannot clone projects.")}
            </Text>
          ) : null}
          <FolderBrowser
            environment={environment}
            navigateToBrowsePath={navigateToBrowsePath}
            pathInput={pathInput}
            setPathInput={setPathInput}
            pinnedDirectoryName={cloneDirectoryName}
            cloning={Boolean(remoteUrl)}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}
