import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { hostQueryScope } from "../state/host-query-scope";
import { useSessionController } from "./use-session-controller";
import { GitBranchesForm } from "../features/threads/git/GitBranchesSheet";
import { useRef, useCallback, useState } from "react";
import { Alert } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { HostApi } from "@solus/client-core/host-api";
import { type GitActionRequestInput } from "@t3tools/client-runtime/state/vcs";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useListened } from "@solus-mobile/app/app-context";
import { EmptyState } from "../components/ui/EmptyState";
import { uuidv4 } from "../lib/uuid";
import { useHostSettingsRead } from "./use-host-settings-read";
import { useSettingsAction } from "./SettingsFeedback";
import { checkoutActions, checkoutStatus } from "./checkout-git";
import { solus } from "./runtime";

type GitTarget = { environmentId: string; threadId: string };

export function useCheckoutGit(controller: ConversationController, cwd: string) {
  const navigation = useNavigation();
  const read = useCallback(
    async (api: HostApi) => {
      const [repo, state] = await Promise.all([
        api.gitRepositoryStatus(cwd),
        api.gitRefreshState(cwd, { includeDetails: true }),
      ]);
      return checkoutStatus(repo, state);
    },
    [cwd],
  );
  const { api, data, refresh, error, isRefreshing } = useHostSettingsRead(
    controller.hostId,
    read,
    "git.checkoutChanged",
  );
  const action = useSettingsAction(refresh);
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
        controller.run.workingDirectory !== cwd
      )
        throw new Error("This checkout is no longer available.");
      if (
        expectedBranch !== undefined &&
        (await api.gitRepositoryStatus(cwd)).branch !== expectedBranch
      )
        throw new Error("The current branch changed. Open the Git action again.");
      const createBeforeAction = input.featureBranch && !input.action.startsWith("commit");
      if (createBeforeAction) {
        const branches = await api.worktreeBranches(controller.context(), { skipFetch: true });
        if (scope !== hostQueryScope(controller.hostId)) throw new Error("The connection changed.");
        const name = resolveAutoFeatureBranchName(
          branches.filter((branch) => !branch.remoteOnly).map((branch) => branch.name),
        );
        if (controller.canChooseStart) {
          const error = await controller.chooseCheckoutBranch(
            { name, remoteOnly: false },
            { create: true, cwd },
          );
          if (error) throw new Error(error);
        } else {
          const result = await api.gitCheckoutBranch(controller.context(), name, {
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
      await api.gitRunAction(controller.context(), {
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
    });
  const pull = () =>
    action.run(async () => {
      if (
        !api ||
        !controller.mayDrive ||
        !solus.connections.may(controller.hostId, "host.git.write") ||
        controller.run.workingDirectory !== cwd
      )
        throw new Error("This checkout is no longer available.");
      const result = await api.gitSync(controller.context());
      if (!result.success) throw new Error(result.error ?? "Could not sync the checkout.");
    });
  return {
    status: data ?? null,
    refreshing: isRefreshing,
    error,
    refresh,
    busy: action.busy,
    perform,
    confirm,
    pull,
    canWrite: !!api && mayWriteGit && controller.mayDrive,
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
  return {
    environmentId,
    threadId: controller.run.sessionId,
    hasThread: !draft,
    currentBranch: git.status?.refName ?? null,
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

export function useCheckoutCommit(controller: ConversationController) {
  const cwd = controller.run.workingDirectory;
  const git = useCheckoutGit(controller, cwd);
  const files = useHostSettingsRead(
    controller.hostId,
    useCallback(
      async (api: HostApi) => {
        const stats = await api.diffStats(controller.context(), {
          scope: { kind: "working-tree" },
        });
        return stats.map((file) => ({
          path: file.path,
          insertions: file.additions,
          deletions: file.deletions,
        }));
      },
      [controller, cwd],
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
      currentBranch={git.status?.refName ?? null}
      currentWorktreePath={controller.run.workingDirectory}
      availableBranches={(branches.data ?? []).map((branch) => ({
        ...branch,
        current: branch.current ?? branch.name === git.status?.refName,
      }))}
      branchesLoading={!branches.data}
      busy={switching || git.busy}
      canChangeThreadBranch={controller.canChooseStart && git.canWrite}
      checkout={(name) => checkout(name)}
      create={(name) => checkout(name, true)}
    />
  );
}
