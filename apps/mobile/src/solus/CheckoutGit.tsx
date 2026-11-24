import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { hostQueryScope } from "../state/host-query-scope";
import { useSessionController } from "./use-session-controller";
import { GitBranchesForm } from "../features/threads/git/GitBranchesSheet";
import { useRef, useCallback, useState } from "react";
import { Alert } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { HostApi } from "@solus/client-core/host-api";
import type { DiffRequest } from "@solus/contracts/git-types";
import { EnvironmentId } from "@t3tools/contracts";
import { type GitActionRequestInput } from "@t3tools/client-runtime/state/vcs";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useListened } from "@solus-mobile/app/app-context";
import { EmptyState } from "../components/ui/EmptyState";
import { uuidv4 } from "../lib/uuid";
import { useHostQueryRead, useHostSettingsRead } from "./use-host-settings-read";
import { checkoutVcsQueries } from "./checkout-git-queries";
import { useSettingsAction } from "./SettingsFeedback";
import { sameHostPath } from "@solus/contracts/host-path";
import {
  gitRepositoryRouteParams,
  type GitRepositoryRouteParams,
} from "../state/thread-git-target";
import {
  checkoutActions,
  checkoutGitTarget,
  type CheckoutGitTarget,
} from "./checkout-git";
import { solus } from "./runtime";
import { useSessionFolders } from "./use-session-controller";

type GitTarget = { environmentId: string; threadId: string };

export function useFolderBranch(hostId: string, cwd: string, enabled = true) {
  const environmentId = EnvironmentId.make(hostId);
  const source = checkoutVcsQueries.branch({ environmentId, input: { cwd } });
  return useHostQueryRead(environmentId, source, undefined, enabled);
}

/**
 * The Git state of one folder on a host, read for the folder's own path. Each
 * session folder has its own branch and its own changes. `includeDetails`
 * adds the line totals and the pull request, which need a scan of the
 * worktree: a list of repositories reads without them.
 */
export function useFolderGitStatus(hostId: string, cwd: string, includeDetails = true) {
  const environmentId = EnvironmentId.make(hostId);
  const branch = useFolderBranch(hostId, cwd);
  const source = checkoutVcsQueries.status({ environmentId, input: { cwd, includeDetails } });
  const details = useHostQueryRead(environmentId, source);
  return {
    ...details,
    repositoryStatus: branch.data,
    error: branch.error ?? details.error,
  };
}

export function useCheckoutGitTarget(
  controller: ConversationController,
  params: GitTarget & GitRepositoryRouteParams,
): CheckoutGitTarget {
  const folders = useSessionFolders(params);
  return checkoutGitTarget(controller.run.workingDirectory, folders, params);
}

export function useCheckoutGit(
  controller: ConversationController,
  cwd: string,
  target?: Pick<CheckoutGitTarget, "repository" | "folder">,
) {
  const navigation = useNavigation();
  const repository = target?.repository;
  const folder = target?.folder;
  const { api, data, repositoryStatus, refresh, error, isRefreshing } = useFolderGitStatus(
    controller.hostId,
    cwd,
  );
  const action = useSettingsAction(refresh);
  // The session still works in the folder of this sheet: its working directory, or a session folder that is still attached.
  const isCurrent = () =>
    repository === undefined
      ? controller.run.workingDirectory === cwd
      : folder !== undefined &&
        controller.sessionFolders.some((each) => sameHostPath(each.path, folder.path));
  // A Git call about a session folder names the folder. The session id stays the session's.
  const context = () => (folder ? controller.folderContext(folder) : controller.context());
  const mayWriteGit = useListened(solus.connections.changes, () =>
    solus.connections.may(controller.hostId, "host.git.write"),
  );
  const perform = async (input: GitActionRequestInput, expectedBranch?: string) => {
    let completed = false;
    const scope = hostQueryScope(controller.hostId);
    await action.run(async () => {
      if (
        !api ||
        !controller.mayDrive ||
        !solus.connections.may(controller.hostId, "host.git.write") ||
        !isCurrent()
      )
        throw new Error("This checkout is no longer available.");
      if (
        expectedBranch !== undefined &&
        (await api.gitRepositoryStatus(cwd)).branch !== expectedBranch
      )
        throw new Error("The current branch changed. Open the Git action again.");
      const createBeforeAction = input.featureBranch && !input.action.startsWith("commit");
      if (createBeforeAction) {
        const branches = await api.worktreeBranches(context(), { skipFetch: true });
        if (scope !== hostQueryScope(controller.hostId)) throw new Error("The connection changed.");
        const name = resolveAutoFeatureBranchName(
          branches.filter((branch) => !branch.remoteOnly).map((branch) => branch.name),
        );
        if (controller.canChooseStart && !folder) {
          const error = await controller.chooseCheckoutBranch(
            { name, remoteOnly: false },
            { create: true, cwd },
          );
          if (error) throw new Error(error);
        } else {
          const result = await api.gitCheckoutBranch(context(), name, {
            create: true,
            remoteOnly: false,
          });
          if (!result.success)
            throw new Error(result.error || "Could not create the feature branch.");
        }
        if ((await api.gitRepositoryStatus(cwd)).branch !== name)
          throw new Error("The checkout changed.");
      }
      if (scope !== hostQueryScope(controller.hostId)) throw new Error("The connection changed.");
      await api.gitRunAction(context(), {
        actionId: uuidv4(),
        action: checkoutActions[input.action],
        createFeatureBranch: !createBeforeAction && input.featureBranch,
        commitMessage: input.commitMessage,
        filePaths: input.filePaths ? [...input.filePaths] : undefined,
      });
      completed = true;
    });
    return completed;
  };
  const confirm = (input: GitActionRequestInput, branch: string) =>
    navigation.navigate("GitConfirm", {
      environmentId: controller.hostId,
      threadId: controller.run.sessionId,
      branchName: branch,
      confirmAction: input.action,
      includesCommit: String(input.action.startsWith("commit")),
      ...(input.commitMessage && { commitMessage: input.commitMessage }),
      ...(input.filePaths && { selectedPaths: [...input.filePaths] }),
      ...gitRepositoryRouteParams(repository),
    });
  const pull = () =>
    action.run(async () => {
      if (
        !api ||
        !controller.mayDrive ||
        !solus.connections.may(controller.hostId, "host.git.write") ||
        !isCurrent()
      )
        throw new Error("This checkout is no longer available.");
      const result = await api.gitSync(context());
      if (!result.success) throw new Error(result.error ?? "Could not sync the checkout.");
    });
  return {
    status: data ?? null,
    repositoryStatus,
    refreshing: isRefreshing,
    error,
    refresh,
    busy: action.busy,
    perform,
    confirm,
    pull,
    canWrite: !!api && mayWriteGit && controller.mayDrive && (repository === undefined || !!folder),
  };
}

export function useCheckoutGitControls(
  controller: ConversationController,
  cwd: string,
  draft: boolean,
) {
  const git = useCheckoutGit(controller, cwd);
  const environmentId = controller.hostId;
  const canOpenFiles = useListened(solus.connections.changes, () =>
    solus.connections.may(environmentId, "host.files.read"),
  );
  const folders = useSessionFolders({ environmentId, threadId: controller.run.sessionId });
  return {
    environmentId,
    threadId: controller.run.sessionId,
    hasThread: !draft,
    // A working directory that is no repository still has the repositories of its session folders to review.
    tracksRepositories: folders.some((folder) => folder.state === "git"),
    currentBranch: git.repositoryStatus?.refName ?? null,
    checkoutIsRepo: git.repositoryStatus?.isRepo,
    gitStatus: git.status,
    gitOperationLabel: git.busy ? "Working…" : null,
    canOpenFiles,
    canWriteGit: git.canWrite,
    onPull: git.pull,
    confirmDefaultBranchAction: git.confirm,
    onRunAction: async (input: GitActionRequestInput) => {
      await git.perform(input);
      return null;
    },
  };
}

function useCheckoutBranches(controller: ConversationController) {
  const cwd = controller.run.workingDirectory;
  const git = useCheckoutGit(controller, cwd);
  const branches = useHostSettingsRead(
    controller.hostId,
    useCallback(
      (api: HostApi) => api.worktreeBranches(controller.context(), { skipFetch: true }),
      [controller, cwd],
    ),
  );
  const lock = useRef(false);
  const [switching, setSwitching] = useState(false);
  const checkout = async (name: string, create = false) => {
    if (
      lock.current ||
      !controller.mayDrive ||
      !controller.canChooseStart ||
      controller.run.workingDirectory !== cwd ||
      !solus.connections.may(controller.hostId, "host.git.write")
    )
      return null;
    const branch = create
      ? { name, remoteOnly: false }
      : branches.data?.find((entry) => entry.name === name);
    if (
      !branch ||
      (!create && "worktreePath" in branch && branch.worktreePath && branch.worktreePath !== cwd)
    )
      return null;
    lock.current = true;
    setSwitching(true);
    try {
      const error = await controller.chooseCheckoutBranch(branch, { create, cwd });
      if (error) throw new Error(error);
      branches.refresh();
      git.refresh();
      return true;
    } catch (error) {
      Alert.alert("Could not change branch", String(error));
      return null;
    } finally {
      lock.current = false;
      setSwitching(false);
    }
  };
  return { git, branches, switching, checkout };
}

export function useCheckoutCommit(controller: ConversationController, target?: CheckoutGitTarget) {
  const cwd = target?.cwd ?? controller.run.workingDirectory;
  const git = useCheckoutGit(controller, cwd, target);
  // The session's own context, with the repository that the diff reads (docs/plans/codebases.md §8).
  const repositoryPath = target?.folder?.path;
  const files = useHostSettingsRead(
    controller.hostId,
    useCallback(
      async (api: HostApi) => {
        const request: DiffRequest = { scope: { kind: "working-tree" } };
        if (repositoryPath !== undefined) request.repositoryPath = repositoryPath;
        const stats = await api.diffStats(controller.context(), request);
        return stats.map((file) => ({
          path: file.path,
          insertions: file.additions,
          deletions: file.deletions,
        }));
      },
      [controller, cwd, repositoryPath],
    ),
  );
  return { git, files };
}

export function CheckoutBranches({ route }: StaticScreenProps<GitTarget>) {
  const controller = useSessionController(route.params);
  return controller ? (
    <Branches key={JSON.stringify(route.params)} controller={controller} />
  ) : (
    <EmptyState title="Session unavailable" detail="Open the session to view branches." />
  );
}
function Branches({ controller }: { controller: ConversationController }) {
  const { git, branches, switching, checkout } = useCheckoutBranches(controller);
  const error = branches.error ?? git.error;
  if (error)
    return (
      <EmptyState
        title="Branches unavailable"
        detail={error}
        actionLabel="Retry"
        onAction={() => {
          branches.refresh();
          git.refresh();
        }}
      />
    );
  return (
    <GitBranchesForm
      currentBranch={git.repositoryStatus?.refName ?? null}
      currentWorktreePath={controller.run.workingDirectory}
      availableBranches={(branches.data ?? []).map((branch) => ({
        ...branch,
        current: branch.current ?? branch.name === git.repositoryStatus?.refName,
      }))}
      branchesLoading={!branches.data}
      busy={switching || git.busy}
      canChangeThreadBranch={controller.canChooseStart && git.canWrite}
      checkout={(name) => checkout(name)}
      create={(name) => checkout(name, true)}
    />
  );
}
