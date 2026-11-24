import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useMemo } from "react";
import { View } from "react-native";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { SheetIntro } from "../../../components/ui/SheetIntro";
import type { GitRepositoryRouteParams } from "../../../state/thread-git-target";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useCheckoutGit, useCheckoutGitTarget } from "../../../solus/CheckoutGit";
import { useSessionController } from "../../../solus/use-session-controller";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
    readonly confirmAction?: string;
    readonly branchName?: string;
    readonly includesCommit?: string;
    readonly commitMessage?: string;
    readonly filePaths?: string;
    readonly selectedPaths?: string[];
  } & GitRepositoryRouteParams
>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const controller = useSessionController(props.route.params);
  return controller ? (
    <Confirmation params={props.route.params} controller={controller} />
  ) : (
    <EmptyState title="Session unavailable" detail="Reconnect to confirm the Git action." />
  );
}

function Confirmation({
  params,
  controller,
}: {
  params: GitConfirmSheetProps["route"]["params"];
  controller: ConversationController;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  // The action of the thread's own folder, or of the repository that the route names.
  const target = useCheckoutGitTarget(controller, params);
  const git = useCheckoutGit(controller, target.cwd, target);
  const action = params.confirmAction;
  const confirmAction =
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
      ? action
      : undefined;
  const branchName = params.branchName ?? "";
  const includesCommit = confirmAction?.startsWith("commit") === true;
  const terminology = sourceControlClients.get(undefined).changeRequest;
  const canWriteSourceControl =
    !!confirmAction &&
    !!git.status &&
    git.status.refName === branchName &&
    git.canWrite &&
    !git.busy;
  const canCreateFeatureBranch = canWriteSourceControl;
  const copy = useMemo(
    () =>
      confirmAction
        ? resolveDefaultBranchActionDialogCopy(
            {
              action: confirmAction,
              branchName,
              includesCommit,
              terminology,
            },
            messages,
          )
        : null,
    [branchName, confirmAction, includesCommit, messages, terminology],
  );

  const run = async (featureBranch: boolean) => {
    if (!confirmAction || !canWriteSourceControl || (featureBranch && !canCreateFeatureBranch))
      return;
    const completed = await git.perform(
      {
        action: confirmAction,
        featureBranch,
        ...(params.commitMessage && { commitMessage: params.commitMessage }),
        filePaths: params.selectedPaths ?? params.filePaths?.split(","),
      },
      branchName,
    );
    if (completed && navigation.isFocused()) navigation.goBack();
  };
  return (
    <FitSheet
      header={<SheetHeader title={gt("Confirm action")} onClose={() => navigation.goBack()} />}
      showsVerticalScrollIndicator={false}
    >
      <SheetIntro
        eyebrow={gt("Confirm", { $context: "eyebrow label above a confirmation title" })}
        title={copy?.title ?? gt("Run action on default branch?")}
        description={copy?.description ?? gt("Choose how to continue.")}
      />

      <View className="gap-3">
        <SheetActionButton
          icon="arrow.right.circle"
          label={copy?.continueLabel ?? gt("Continue")}
          disabled={!canWriteSourceControl}
          onPress={() => void run(false)}
        />
        <SheetActionButton
          icon="arrow.branch"
          label={gt("Feature branch & continue")}
          disabled={!canCreateFeatureBranch}
          tone="primary"
          onPress={() => void run(true)}
        />
      </View>
    </FitSheet>
  );
}
