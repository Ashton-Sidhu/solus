import { beginHostQueuedRunEdit, hostQueueMessage, hostQueuedEditMutation } from "./queue-messages";
import {
  hostApprovalCard,
  hostApprovalResponder,
  sendHostApprovalFeedback,
  useHostApprovalResponses,
} from "./approval-requests";
import { hostComposerDelivery } from "./composer-delivery";
import type { TurnSnapshot } from "@solus/contracts/git-types";
import type { HostApi } from "@solus/client-core/host-api";
import { useHostSettingsRead } from "./use-host-settings-read";
import { conversationCheckpoints } from "./conversation-checkpoints";
import { backgroundTasks } from "./session-work";
import { sessionPromptText } from "./review-prompt";
import { finishDraftSubmission } from "../features/threads/finish-draft-submission";
import type { ThreadDetailScreenProps } from "../features/threads/ThreadDetailScreen";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../state/preferences";
import type { ComposerEditorHandle } from "../components/ComposerEditor";
import {
  useQueuedRunEdit,
  endQueuedRunEdit,
  queuedEditDraftKey,
  startQueuedRunEditSave,
} from "../state/queued-run-edit";
import type { QueueAttachment } from "@solus/contracts/session-queue";
import { isChat } from "@solus/contracts/chat";
import { useRememberThreadProject } from "../features/threads/useRememberThreadProject";
import { removeQueuedRunEditAttachment } from "../state/queued-run-edit";
import { videoMimeType } from "@solus/contracts/media-types";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { composerUploadMedia } from "./upload-images";
import {
  pendingInputAnswers,
  pendingInputQuestions,
  toggleQuestionOption,
  typeQuestionRemark,
} from "./pending-question";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { connectionTone } from "../features/connection/connectionTone";
import { hasOwnCard } from "@solus-mobile/features/conversation/lib/pending-requests";
import {
  pickComposerMedia,
  pickComposerFiles,
  pastedComposerImages,
} from "@solus-mobile/features/threads/composer-attachment-pickers";
import { modelInstanceId, runOptionSelections } from "./model-picker-catalog";
import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { RequestCards, RequestPanels } from "./RequestCards";
import {
  ConversationMedia,
  conversationImageSource,
  resolveConversationImage,
} from "./ConversationMedia";
import { ThreadMcpApp } from "@solus-mobile/features/threads/ThreadMcpApp";
import { ConversationCard } from "./ConversationCard";
import { scopedThreadKey } from "../lib/scopedEntities";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { EnvironmentId, MessageId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { isSessionBusyStatus, isSteerableStatus, requestExpiryText } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { conversationFeed } from "./conversation-feed";
import {
  clearComposerDraft,
  clearComposerDraftContent,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  questionAttachmentDraftsAtom,
  sameComposerDraftState,
  setComposerDraftText,
  setComposerDraftContext,
} from "../state/use-composer-drafts";
import { hostQueryScope, useHostQueryScope } from "../state/host-query-scope";
import { appAtomRegistry } from "../state/atom-registry";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "../state/question-attachments";
import { useListened } from "@solus-mobile/app/app-context";
import { solus, useSolusWorkspace } from "./runtime";
import { toThreadShell } from "./session";
const wip = () => Alert.alert("WIP");
function useFeed(
  store: ConversationStore,
  id: string,
  snapshots: readonly TurnSnapshot[] | null | undefined,
  latestOnly: boolean,
  isWorking: boolean,
) {
  const order = useSyncExternalStore(store.order.subscribe, store.orderSnapshot);
  const checkpoints = useMemo(
    () => conversationCheckpoints(order, (key) => store.item(key), snapshots, latestOnly, isWorking),
    [order, store, snapshots, latestOnly, isWorking],
  );
  const projectFeed = useMemo(() => {
    return conversationFeed(
      store,
      id,
      (key, superseded, liveAppOnly, artifactGroup) =>
        liveAppOnly ? (
          <ThreadMcpApp store={store} id={key} />
        ) : (
          <ConversationCard
            key={key}
            store={store}
            id={key}
            superseded={superseded}
            artifactGroup={artifactGroup}
          />
        ),
      (path, refresh) => resolveConversationImage(store, path, refresh).then((image) => image.uri),
      (key) => store.controller.readToolInput(key),
    );
  }, [store, id]);
  const reader = useMemo(() => projectFeed(order, checkpoints), [projectFeed, order, checkpoints]);
  return useSyncExternalStore(reader.subscribe, reader.get);
}

export function useThreadScreenData({
  draftKey,
  isDraft,
  store,
  hostId,
  id,
}: {
  store: ConversationStore;
  draftKey?: string;
  isDraft: boolean;
  hostId: string;
  id: string;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const showToolCalls = useSyncExternalStore(
    solus.personal.changes.subscribe,
    () => solus.personal.current().showToolCalls,
  );
  const controller = store.controller;
  const meta = useSyncExternalStore(store.meta.subscribe, store.metaSnapshotOf);
  const environmentId = EnvironmentId.make(hostId);
  const threadId = ThreadId.make(id);
  const followUpBehavior = AsyncResult.isSuccess(preferences)
    ? preferences.value.followUpBehavior ?? "queue"
    : "queue";
  const queuedMessages = useMemo(
    () =>
      meta.queue.entries
        .filter((entry) => entry.kind !== "provider_switch")
        .map((entry) =>
          hostQueueMessage(environmentId, threadId, entry, (path, refresh) =>
            resolveConversationImage(store, path, refresh).then((image) => image.uri),
          ),
        ),
    [meta.queue.entries, environmentId, threadId, store],
  );
  const showChangedFiles = useSyncExternalStore(
    solus.personal.changes.subscribe,
    () => solus.personal.current().showDiffSummaryAfterTurn,
  );
  const keepEarlierChanges = useSyncExternalStore(
    solus.personal.changes.subscribe,
    () => solus.personal.current().keepDiffSummaryOnEarlierTurns,
  );
  const readSnapshots = useCallback(
    (api: HostApi) => api.listTurnSnapshots(controller.context()),
    [controller],
  );
  const snapshots = useHostSettingsRead(
    hostId, readSnapshots, "git.checkoutChanged", showChangedFiles && controller.hasStarted,
  );
  const lastSettled = useRef(meta.latestSettledTurnId);
  useEffect(() => {
    if (lastSettled.current === meta.latestSettledTurnId) return;
    lastSettled.current = meta.latestSettledTurnId;
    if (showChangedFiles && meta.latestSettledTurnId) snapshots.refresh();
  }, [meta.latestSettledTurnId, showChangedFiles, snapshots.refresh]);
  const directory = useSolusWorkspace();
  const navigation = useNavigation();
  const [openedAt] = useState(Date.now);
  const listed = useSyncExternalStore(
    solus.threads.changes.subscribe,
    () => solus.threads.thread(hostId, id)?.record,
  );
  const busy = isSessionBusyStatus(meta.status);
  const feed = useFeed(
    store, id, showChangedFiles ? snapshots.data : undefined, !keepEarlierChanges, busy,
  );
  const shell = toThreadShell(
    hostId,
    {
      ...(listed ?? {
        sessionId: id,
        provider: meta.run.provider,
        projectPath: meta.run.workingDirectory,
        title: meta.run.title,
        customTitle: null,
        createdAt: openedAt,
        lastActivityAt: openedAt,
        model: meta.run.model,
        cwd: null,
        isWorktree: false,
        branch: null,
        status: "idle",
      }),
      provider: meta.run.provider,
      model: meta.run.model,
      status: busy ? "running" : listed?.status === "interrupted" ? "interrupted" : "idle",
    },
    meta.run.permissionMode,
  );
  const env = directory.environments.find((entry) => entry.environmentId === hostId);
  const firstPromptEditor = useRef<ComposerEditorHandle>(null);
  const [startingDraft, setStartingDraft] = useState<{
    media: DraftComposerAttachment[];
    count: number;
  } | null>(null);
  const showingDraft =
    isDraft &&
    (startingDraft !== null ||
      !feed.some((row) => row.type === "message" && row.message.role === "user"));
  const key = scopedThreadKey(environmentId, threadId);
  const chooseDraftContext = (environment: boolean) => {
    const source =
      meta.attachments.length || meta.uploading ? { hostId, sessionId: id } : undefined;
    const saved =
      draftKey ??
      createNewTaskDraft({ environmentId: shell.environmentId, projectId: shell.projectId });
    if (!draftKey) {
      const draft = getComposerDraftSnapshot(key);
      setComposerDraftText(saved, draft.text);
      setComposerDraftContext(saved, draft.context);
    }
    if (environment)
      navigation.navigate("NewTaskEnvironment", { draftId: saved, environmentId: hostId, source });
    else navigation.navigate("NewTaskProject", { draftId: saved, source });
  };
  const project = directory.projects.find(
    (p) => p.environmentId === hostId && p.id === shell.projectId,
  );
  useRememberThreadProject(project ?? null);
  // A container is a codebase, not a project: a draft or a session in its folder names the codebase.
  const containerName = useListened(solus.codebases.changes, () =>
    project ? undefined : solus.codebases.containerCodebaseAt(hostId, shell.projectId)?.name,
  );
  const placeName = project?.title ?? containerName;
  const draftTitle =
    placeName ?? (isChat(meta.run.workingDirectory) ? "No project" : meta.run.workingDirectory);
  const edit = useQueuedRunEdit(key);
  const editedModel = edit?.hostModelSelection ?? edit?.hostInitialModel;
  const inputKey = draftKey ?? key;
  const composerKey = edit ? queuedEditDraftKey(key, edit.runId) : inputKey;
  const [savingEdit, setSavingEdit] = useState(false);
  const [editUploads, setEditUploads] = useState<(QueueAttachment & { previewUri: string })[]>([]);
  const [pickingEdit, setPickingEdit] = useState(false);
  const editRunId = edit?.runId;
  useEffect(() => {
    setEditUploads([]);
    setPickingEdit(false);
  }, [editRunId]);
  const currentEdit = useRef(editRunId);
  useLayoutEffect(() => {
    currentEdit.current = editRunId;
  }, [editRunId]);
  const pickFiles = async (pick: typeof pickComposerFiles) => {
    if (!controller.mayDrive) return false;
    if (edit && pickingEdit) return false;
    if (edit) setPickingEdit(true);
    return pick()
      .then(async (files) => {
        if (!files.length) return false;
        if (edit) {
          const uploads = await controller.uploadPickedFiles(files);
          if (currentEdit.current === edit.runId)
            setEditUploads((old) => [
              ...old,
              ...uploads.map((file, i) => ({ ...file, previewUri: files[i]!.uri })),
            ]);
        } else await controller.attach(files);
        return true;
      })
      .catch(() => {
        Alert.alert(
          "Could not attach file",
          "Check the file and the host connection, then try again.",
        );
        return false;
      })
      .finally(() => {
        if (edit && currentEdit.current === edit.runId) setPickingEdit(false);
      });
  };
  const firstQuestion = meta.questions.find((q) => !q.expired);
  const question = hasOwnCard(firstQuestion) ? null : firstQuestion;
  const isAsyncQuestion = question?.responseMode === "message";
  const pending = question
    ? {
        requestId: RuntimeRequestId.make(question.questionId),
        createdAt: shell.updatedAt,
        responseCapability: "live" as const,
        dismissible: isAsyncQuestion,
        questions: pendingInputQuestions(question),
      }
    : null;
  const connectionScope = useHostQueryScope(hostId);
  const accountScope = solus.sessionCache.scope();
  const facts = solus.connections.connection(hostId)?.facts;
  useEffect(() => {
    if (isAsyncQuestion) facts?.ensure("capabilities");
  }, [facts, isAsyncQuestion]);
  const canUploadQuestionAttachments = useSyncExternalStore(
    useCallback((notify) => facts?.subscribe(notify) ?? (() => {}), [facts]),
    () => facts?.value("capabilities")?.attachUpload === true,
  ) && controller.mayDrive;
  const attachmentDrafts = useAtomValue(
    questionAttachmentDraftsAtom(isAsyncQuestion
      ? questionAttachmentDraftPrefix(environmentId, threadId, accountScope)
      : ""),
  );
  const preparations = useAtomValue(questionAttachmentPreparationAtom);
  const attachmentKeys = isAsyncQuestion && pending
    ? pending.questions.map(({ id }) => questionAttachmentDraftKey(
      environmentId, threadId, pending.requestId, id, accountScope,
    ))
    : [];
  const draftOwner = JSON.stringify([accountScope, hostId, threadId, pending?.requestId]);
  const [draftState, setDraftState] = useState<{
    id: string;
    drafts: Record<string, PendingUserInputDraftAnswer>;
  }>({ id: "", drafts: {} });
  const drafts = draftState.id === draftOwner ? draftState.drafts : {};
  const [respondingQuestion, setRespondingQuestion] = useState<string | null>(null);
  const questionResponses = useRef(new Set<string>());
  const { respondToPermission, respondingPermissionId } = useHostApprovalResponses(store);
  const answerDrafts = isAsyncQuestion && pending
    ? Object.fromEntries(pending.questions.map(({ id }, index) => {
      const key = attachmentKeys[index]!;
      const attachmentCount = attachmentDrafts[key]?.attachments.length ?? 0;
      return [id, {
        ...drafts[id],
        attachmentCount,
        attachmentsBlocked: (preparations[key] ?? 0) > 0 ||
          (attachmentCount > 0 && !canUploadQuestionAttachments),
      }];
    }))
    : drafts;
  const answers = pending ? buildPendingUserInputAnswers(pending.questions, answerDrafts) : null;
  const respondToQuestion = async (dismiss: boolean) => {
    if (!pending || !controller.mayApprove || questionResponses.current.has(draftOwner) ||
        (dismiss ? !pending.dismissible : !answers)) return;
    if (connectionScope !== hostQueryScope(hostId)) return;
    if (!dismiss && attachmentKeys.some((key) =>
      (appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0)) return;
    questionResponses.current.add(draftOwner);
    setRespondingQuestion(draftOwner);
    try {
      const attachmentPaths: Record<string, string[]> = {};
      if (!dismiss) {
        for (const [index, key] of attachmentKeys.entries()) {
          const attachments = getComposerDraftSnapshot(key).attachments;
          if (attachments.length === 0) continue;
          const uploaded = await controller.uploadPickedFiles(attachments.map((attachment) => {
            if (!attachment.fileUri) throw new Error("The attached file is no longer on this device.");
            return { uri: attachment.fileUri, name: attachment.name, mimeType: attachment.mimeType, size: attachment.sizeBytes };
          }));
          attachmentPaths[pending.questions[index]!.id] = uploaded.map((file) => file.hostPath);
        }
      }
      if (connectionScope !== hostQueryScope(hostId) ||
          !controller.model.questions.some((question) => question.questionId === pending.requestId && !question.expired)) return;
      const sent = await controller.answerQuestion(
        pending.requestId,
        dismiss ? {} : pendingInputAnswers(pending.questions, drafts, attachmentPaths),
      );
      if (sent) {
        for (const key of attachmentKeys) clearComposerDraft(key);
      }
    } catch (error) {
      if (connectionScope === hostQueryScope(hostId))
        Alert.alert("Could not send the answer", error instanceof Error ? error.message : "Try again.");
    } finally {
      questionResponses.current.delete(draftOwner);
      setRespondingQuestion((current) => current === draftOwner ? null : current);
    }
  };
  const displayedPermission = meta.permissions.find((item) => !item.expired) ?? meta.permissions[0];
  const projectedApproval = displayedPermission ? hostApprovalCard(displayedPermission) : null;
  const approval = projectedApproval ? { ...projectedApproval.approval, createdAt: shell.updatedAt } : null;
  const respondToApproval = hostApprovalResponder(
    projectedApproval?.optionIds ?? new Map(),
    respondToPermission,
  );
  const binding = {
    selectedThread: { ...shell, pendingBackgroundTasks: backgroundTasks(controller.model) },
    onStopBackgroundWork: () => void controller.stopBackgroundWork(),
    composerModelSelection: editedModel
      ? {
          instanceId: modelInstanceId(editedModel.provider),
          model: editedModel.modelConfig.modelId ?? "",
          options: runOptionSelections(editedModel.modelConfig),
        }
      : undefined,
    modelDisplayName: modelLabel(
      editedModel?.provider ?? meta.run.provider,
      editedModel ? (editedModel.modelConfig.modelId ?? "") : meta.run.model,
      meta.runOptions.agents?.find((agent) => agent.id === (editedModel?.provider ?? meta.run.provider)),
    ),
    environmentId,
    projectWorkspaceRoot: meta.run.workingDirectory,
    threadCwd: meta.run.workingDirectory,
    selectedThreadDetailRef: null,
    selectedThreadFeed: feed,
    hostImageRenderer: (image) => (
      <ConversationMedia
        key={image.href}
        store={store}
        label={image.alt ?? image.title ?? "Image"}
        source={conversationImageSource(image.href)}
      />
    ),
    hostImageSource: (image) => resolveConversationImage(store, image.href),
    screenTone: connectionTone(env?.connectionState ?? "offline"),
    connectionError: meta.phase.kind === "error" ? meta.phase.message : null,
    contentPresentation:
      meta.phase.kind === "error" && (meta.phase.noAccess || !feed.length)
        ? { kind: "unavailable", title: "Session unavailable", detail: meta.phase.message }
        : { kind: feed.length || meta.phase.kind === "error" ? "ready" : meta.phase.kind },
    historyControls: {
      hasMoreHistory: meta.hasOlder,
      loading: meta.loadingOlder,
      error: meta.historyError,
      onLoadEarlier: () => void controller.loadOlder(),
      onLoadThrough: () => void controller.loadOlder(),
    },
    environmentLabel: env?.environmentLabel ?? null,
    connectionStateLabel: env?.connectionState ?? "offline",
    canOperateThread: controller.mayDrive,
    activeThreadBusy: busy,
    canStopThread: !showingDraft && meta.canStopTurn && controller.mayDrive,
    onStopThread: () =>
      void controller.stop().catch((e: Error) => Alert.alert("Stop failed", e.message)),
    onReconnectEnvironment: () => solus.connections.retry(hostId),
    onOpenConnectionEditor: () => navigation.navigate("SettingsEnvironments"),
    requestPanels:
      Boolean(displayedPermission && !approval) ||
      hasOwnCard(firstQuestion ?? meta.questions[0]) ||
      meta.pendingPlan ||
      meta.agentPlans.length > 0 ? (
        <RequestPanels
          store={store}
          meta={meta}
          showPermission={approval === null}
          respondToPermission={respondToPermission}
          respondingPermissionId={respondingPermissionId}
        />
      ) : null,
    composerCards: <RequestCards store={store} meta={meta} draft={showingDraft} />,
    privateInputActive: hasOwnCard(firstQuestion),
    mayAnswerRequests: controller.mayApprove,
    activePendingApproval: approval,
    activePendingApprovals: approval ? [approval] : [],
    approvalFeedbackOnly: true,
    approvalExpiryReason: displayedPermission?.expired
      ? requestExpiryText(displayedPermission.expired)
      : undefined,
    respondingApprovalId: respondingPermissionId ? RuntimeRequestId.make(respondingPermissionId) : null,
    onRespondToApproval: respondToApproval,
    composerDraftKey: composerKey,
    onChangeDraftMessage: (text) => setComposerDraftText(composerKey, text),
    onSendCommand: async (text) => {
      if (!controller.mayDrive) return null;
      let commandId: MessageId | null = null;
      await controller.send(text, {
        onSubmitted: (id) => {
          commandId = MessageId.make(id);
        },
      });
      return commandId;
    },
    onSendMessage: async (action, before, onWillEnqueue) => {
      const accountScope = solus.sessionCache.scope();
      const draft = getComposerDraftSnapshot(composerKey);
      const sameDraft = () =>
        accountScope === solus.sessionCache.scope() &&
        sameComposerDraftState(draft, getComposerDraftSnapshot(composerKey));
      const prompt = sessionPromptText(draft.text, draft.context);
      if (edit) {
        if (
          !controller.mayDrive ||
          pickingEdit ||
          (!prompt.trim() && !edit.existingAttachments.length && !editUploads.length)
        )
          return null;
        const finish = startQueuedRunEditSave(key);
        if (!finish) return null;
        const entry = store.metaSnapshotOf().queue.entries.find((item) => item.queueId === edit.runId);
        if (!entry) {
          if (finish(false))
            Alert.alert("Could not edit queued message", "This message already left the queue.");
          return null;
        }
        setSavingEdit(true);
        const scope = hostQueryScope(hostId);
        try {
          await controller.changeQueue(hostQueuedEditMutation(
            edit, entry, prompt, editUploads.map(({ previewUri, ...file }) => file),
          ));
          if (!finish(true) || scope !== hostQueryScope(hostId)) return null;
          if (sameDraft()) setComposerDraftText(composerKey, "");
          return edit.messageId;
        } catch (error) {
          if (finish(false) && scope === hostQueryScope(hostId))
            Alert.alert("Could not edit queued message", String(error));
          return null;
        } finally {
          setSavingEdit(false);
        }
      }
      if (
        (!prompt.trim() && !controller.attachments.length && !controller.uploading) ||
        store.metaSnapshotOf().questions.some((question) => !question.expired)
      )
        return null;
      const permission = store.metaSnapshotOf().permissions.find((item) => !item.expired);
      if (permission) {
        if (before) {
          if (approval?.requestId !== permission.questionId) return null;
          const result = await before(
            draft.text,
            Boolean(draft.context || controller.attachments.length || controller.uploading),
          );
          if (result === "responded" && sameDraft()) clearComposerDraftContent(inputKey);
          return null;
        }
        if (
          !controller.mayApprove ||
          draft.context !== undefined ||
          controller.attachments.length ||
          controller.uploading
        )
          return null;
        if (await sendHostApprovalFeedback(permission, prompt, respondToPermission)) {
          if (sameDraft())
            setComposerDraftText(inputKey, "");
        }
        return null;
      }
      if (before) {
        const response = await before(
          draft.text,
          Boolean(draft.context || controller.attachments.length || controller.uploading),
        );
        if (!sameDraft()) return null;
        if (response === "responded") clearComposerDraftContent(inputKey);
        if (response !== true) return null;
      }
      if (!controller.mayDrive || accountScope !== solus.sessionCache.scope()) return null;
      const status = store.metaSnapshotOf().status;
      const delivery = hostComposerDelivery(status, followUpBehavior, action);
      onWillEnqueue?.();
      if (showingDraft) {
        setStartingDraft({
          media: composerUploadMedia(id, meta.attachments, meta.pendingImages, meta.pendingVideos, meta.failedAttachments),
          count: meta.attachments.length + meta.uploading + meta.failedAttachments.length,
        });
      }
      return new Promise<MessageId | null>((resolve) => {
        let cleared = false;
        const accept = (messageId: string) => {
          if (accountScope !== solus.sessionCache.scope()) {
            resolve(null);
            return;
          }
          if (showingDraft) {
            finishDraftSubmission(
              navigation,
              inputKey,
              draft.text,
              hostId,
              id,
            );
            setStartingDraft(null);
          } else if (sameDraft()) {
            clearComposerDraftContent(inputKey);
            cleared = true;
          }
          resolve(MessageId.make(messageId));
        };
        const recover = () => {
          if (accountScope === solus.sessionCache.scope()) {
            if (showingDraft) setStartingDraft(null);
            if (cleared) {
              void mergeComposerDraftContent(inputKey, draft).catch((error) =>
                Alert.alert("Could not restore draft", String(error)),
              );
            }
          }
          resolve(null);
        };
        void controller
          .send(prompt, {
            delivery,
            // Upstream leaves a new draft after its local save. An open thread
            // clears immediately and recovers its draft if that save fails.
            ...(showingDraft ? { onQueued: accept } : { onSubmitted: accept }),
            onUploadFailed: () => {
              recover();
              if (showingDraft && accountScope === solus.sessionCache.scope())
                Alert.alert("Could not send prompt", "Check the attachments and try again.");
            },
          })
          .then(
            () => {
              if (showingDraft && accountScope === solus.sessionCache.scope())
                setStartingDraft(null);
              resolve(null);
            },
            (error) => {
              recover();
              if (accountScope === solus.sessionCache.scope())
                Alert.alert("Send failed", String(error));
            },
          );
      });
    },
    selectedThreadQueueCount: meta.queue.entries.length,
    showToolCalls: showToolCalls,
    followUpBehavior,
    canSteerActiveTurn: isSteerableStatus(meta.status) ||
      (approval?.supportsFeedback === true && approval.responseCapability === "live"),
    onResumeQueue: meta.queue.held && controller.mayDrive
      ? () => controller.changeQueue({ kind: "resume" })
      : null,
    queuedMessages,
    editHostQueuedMessage: !controller.mayDrive
      ? null
      : (message) => {
          const entry = store.metaSnapshotOf().queue.entries.find(
            (item) => (item.clientPromptId ?? item.queueId) === message.messageId,
          );
          if (!entry) return false;
          return beginHostQueuedRunEdit(store, message, entry.queueId, (path, refresh) =>
            resolveConversationImage(store, path, refresh).then((image) => image.uri),
          );
        },
    dispatchingMessageId: null,
    serverConfig: null,
    activePendingUserInput: pending,
    questionAttachmentAccess: isAsyncQuestion
      ? { accountScope, canUpload: canUploadQuestionAttachments }
      : undefined,
    activePendingUserInputDrafts: drafts,
    activePendingUserInputAnswers: answers,
    respondingUserInputId: respondingQuestion === draftOwner ? pending?.requestId ?? null : null,
    onSelectUserInputOption: (_id, q, value) =>
      setDraftState({
        id: draftOwner,
        drafts: {
          ...drafts,
          [q.id]: toggleQuestionOption(q, drafts[q.id], value),
        },
      }),
    onChangeUserInputCustomAnswer: (_id, key, value) =>
      setDraftState({ id: draftOwner, drafts: { ...drafts, [key]: typeQuestionRemark(drafts[key], value) } }),
    onSubmitUserInput: () => respondToQuestion(false),
    onDismissUserInput: () => respondToQuestion(true),
    hostMedia: edit
      ? editUploads.flatMap((a): DraftComposerAttachment[] =>
          a.type === "image"
            ? [
                {
                  type: "image" as const,
                  id: a.id,
                  name: a.name,
                  sizeBytes: a.size ?? 0,
                  mimeType: a.mimeType || "image/png",
                  previewUri: a.previewUri,
                },
              ]
            : videoMimeType(a)
              ? [
                  {
                    type: "file",
                    id: a.id,
                    name: a.name,
                    sizeBytes: a.size ?? 0,
                    mimeType: videoMimeType(a)!,
                    fileUri: a.previewUri,
                  },
                ]
              : [],
        )
      : (startingDraft?.media ??
        composerUploadMedia(id, meta.attachments, meta.pendingImages, meta.pendingVideos, meta.failedAttachments)),
    hostAttachmentCount: edit
      ? editUploads.length + Number(pickingEdit)
      : (startingDraft?.count ?? meta.attachments.length + meta.uploading + meta.failedAttachments.length),
    onPickDraftMedia: async () => {
      await pickFiles(pickComposerMedia);
    },
    onPickDraftFiles: async () => {
      await pickFiles(pickComposerFiles);
    },
    onNativePasteImages: (uris) => pickFiles(() => pastedComposerImages(uris)),
    onNativePasteText: async (paste) =>
      setComposerDraftText(composerKey, getComposerDraftSnapshot(composerKey).text + paste.text),
    onRetryHostAttachment: (id: string) => { void controller.retryAttachment(id); },
    onRemoveDraftImage: (id) =>
      edit
        ? setEditUploads((files) => files.filter((f) => f.id !== id))
        : controller.removeAttachment(id),
    feedbackSubmissions: [],
    onDismissFeedback: wip,
    activityRun: null,
    providerStartup: busy ? meta.providerStartup : null,
    runlessWorkActive: busy,
    activeWorkStartedAt: busy
      ? feed.findLast((entry) => entry.type === "message" && entry.message.role === "user")
          ?.createdAt || null
      : null,
    isCompacting: false,
    creationState: null,
    queuedRunEdit: edit,
    isSavingQueuedEdit: savingEdit,
    onCancelQueuedRunEdit: () => endQueuedRunEdit(key),
    onRemoveQueuedEditAttachment: (id) => removeQueuedRunEditAttachment(key, id),
    canSwitchThreadProvider: false,
    offersSideChat: false,
  } satisfies Omit<ThreadDetailScreenProps, "header">;
  return {
    binding,
    draft: showingDraft
      ? {
          editorRef: firstPromptEditor,
          disabled: startingDraft !== null || !controller.mayDrive,
          scratch: isChat(meta.run.workingDirectory),
          title: draftTitle,
          chooseProject: () => chooseDraftContext(false),
          chooseEnvironment: () => chooseDraftContext(true),
          environmentLabel: env?.environmentLabel ?? hostId,
          connectionState: env?.connectionState ?? ("offline" as const),
        }
      : null,
    header: {
      controller,
      draftKey: showingDraft ? draftKey : undefined,
      cwd: meta.run.workingDirectory,
      projectName: draftTitle,
      title: shell.title,
      subtitle: showingDraft
        ? ""
        : [placeName, env?.environmentLabel].filter(Boolean).join(" · "),
      draft: showingDraft,
    },
  };
}
