import { useNavigation } from "@react-navigation/native";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { T, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { ComposerInlineControl } from "../components/ComposerToolbar";
import { AppText as Text } from "../components/ui/AppText";
import * as Dialog from "../components/ui/Dialog";
import { NewTaskWorkspaceIcon } from "../features/threads/NewTaskDraftScreen";
import { resolveNewTaskWorkspaceLabel } from "../features/threads/new-task-context-presentation";
import { useFolderGitStatus } from "./CheckoutGit";
import type { DraftCodebase } from "./session-repositories";
import { useDraftStart } from "./use-draft-start";

/**
 * The base that a new worktree of a plain project folder names. The host
 * needs a base for each new worktree. No repository has a branch with this
 * name, so each repository starts from its own default branch: the control
 * says "Default branches" (docs/plans/codebases.md §7).
 */
const REPOSITORY_DEFAULTS_BASE = "HEAD";

/** The codebase of the new thread. It shows only when more than one codebase holds the folder: one codebase needs no choice. */
function CodebaseControl(props: {
  readonly codebase: DraftCodebase;
  readonly controller: ConversationController;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const { codebase, controller } = props;
  if (codebase.options.length < 2) return null;
  const selected = codebase.options.find((option) => option.id === codebase.codebaseId);
  const label = codebase.needsChoice
    ? gt("Choose codebase")
    : (selected?.name ?? gt("No codebase"));
  const choose = () =>
    Dialog.alert(gt("Codebase"), undefined, [
      ...codebase.options.map((option) => ({
        text: option.name,
        onPress: () => controller.chooseCodebase(option.id),
      })),
      { text: gt("No codebase"), onPress: () => controller.chooseCodebase(null) },
      { text: gt("Cancel"), style: "cancel" as const },
    ]);
  return (
    <ChoiceControl
      accessibilityHint={gt("Chooses the codebase of the new thread")}
      accessibilityLabel={gt("Codebase: {codebase}", { codebase: label })}
      disabled={props.disabled}
      icon="folder"
      label={label}
      needsChoice={codebase.needsChoice}
      onPress={choose}
    />
  );
}

/** A control that opens a list of choices. It has the warning tone while the person must choose. */
function ChoiceControl(props: {
  readonly accessibilityHint: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly icon: "folder" | "folder.badge.plus";
  readonly label: string;
  readonly needsChoice: boolean;
  readonly onPress: () => void;
}) {
  const { needsChoice, ...control } = props;
  return (
    <View className="min-w-0 shrink">
      {needsChoice ? (
        <ComposerInlineControl
          {...control}
          chevronDirection="right"
          maxWidth="100%"
          tone="warning"
        />
      ) : (
        <ComposerInlineControl {...control} chevronDirection="right" maxWidth="100%" />
      )}
    </View>
  );
}

/** The branch of the checkout, or the base of the new worktree. A plain folder has no branch: each repository then starts from its own default branch. */
function BranchControl(props: {
  readonly startsNewWorktree: boolean;
  readonly isRepo: boolean;
  readonly branch: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  if (props.startsNewWorktree && !props.isRepo) {
    return (
      <View className="min-h-8 min-w-0 shrink justify-center px-2">
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          <T>Default branches</T>
        </Text>
      </View>
    );
  }
  return (
    <View className="min-w-0 shrink">
      <ComposerInlineControl
        accessibilityLabel={
          props.startsNewWorktree
            ? gt("Base branch: {branch}", { branch: props.branch })
            : gt("Branch: {branch}", { branch: props.branch })
        }
        chevronDirection="right"
        disabled={props.disabled || !props.isRepo}
        icon="arrow.triangle.branch"
        label={props.branch}
        maxWidth="100%"
        onPress={props.onPress}
      />
    </View>
  );
}

/**
 * T3's workspace controls of a new thread (`NewTaskDraftScreen`), for a Solus
 * draft: the codebase, the checkout or a new worktree, the repositories of
 * the new worktree, and the branch. Each control writes the start of the run
 * (`ConversationController`), which the first prompt sends.
 */
export function DraftWorkspaceControls(props: {
  readonly store: ConversationStore;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const { controller } = props.store;
  const { meta, codebase, choices, selection } = useDraftStart(props.store);
  const hostId = controller.hostId;
  const git = useFolderGitStatus(hostId, meta.run.projectDirectory);
  if (!meta.runOptions.canChooseStart) return null;

  const isRepo = git.data?.isRepo ?? false;
  const projectBranch = git.data?.refName ?? null;
  const base = meta.run.worktreeBaseBranch;
  const startsNewWorktree = base !== null;
  const workspaceMode = startsNewWorktree ? "worktree" : "local";
  const workspaceLabel = resolveNewTaskWorkspaceLabel(
    { workspaceMode, worktreePath: meta.run.checkoutWorktree },
    messages,
  );
  const route = { environmentId: hostId, threadId: controller.run.sessionId };
  const newWorktreeBase = (isRepo ? projectBranch : null) ?? REPOSITORY_DEFAULTS_BASE;

  return (
    <View className="flex-row flex-wrap items-center gap-x-1 px-2">
      <CodebaseControl codebase={codebase} controller={controller} disabled={props.disabled} />
      <ComposerInlineControl
        accessibilityHint={
          startsNewWorktree
            ? gt("Switches to the current checkout")
            : gt("Switches to a new worktree")
        }
        accessibilityLabel={workspaceLabel}
        // A plain folder can get a worktree only through the repositories of its codebase.
        disabled={
          props.disabled || git.data === undefined || !(isRepo || choices.tracksGitRepositories)
        }
        renderIcon={(size) => (
          <NewTaskWorkspaceIcon
            workspaceMode={workspaceMode}
            worktreePath={meta.run.checkoutWorktree}
            size={size}
          />
        )}
        label={workspaceLabel}
        maxWidth="100%"
        onPress={() => controller.chooseWorktreeBase(startsNewWorktree ? null : newWorktreeBase)}
        showChevron={false}
      />
      {startsNewWorktree && (choices.choices?.length ?? 0) > 0 ? (
        <ChoiceControl
          accessibilityHint={gt("Chooses the repositories the new worktree holds")}
          accessibilityLabel={gt("Repositories in the new worktree: {selection}", {
            selection: selection.label,
          })}
          disabled={props.disabled}
          icon="folder.badge.plus"
          label={selection.label}
          needsChoice={selection.needsChoice}
          onPress={() => navigation.navigate("NewTaskRepositories", route)}
        />
      ) : null}
      <BranchControl
        startsNewWorktree={startsNewWorktree}
        isRepo={isRepo}
        branch={base ?? meta.run.checkoutBranch ?? projectBranch ?? gt("Detached HEAD")}
        disabled={props.disabled}
        onPress={() => navigation.navigate("NewTaskBranch", route)}
      />
    </View>
  );
}
