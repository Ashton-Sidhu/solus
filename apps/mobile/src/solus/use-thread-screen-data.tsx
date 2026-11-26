import { parseSideChatCommand } from "@t3tools/shared/composerTrigger";
import { isPickerProvider } from "./use-model-picker-host";
import { projectThreadContentPresentation, threadSyncStatusLabel } from "../features/threads/threadContentPresentation";
import { useDelayedStatus } from "../lib/useDelayedStatus";
import { beginHostQueuedRunEdit, hostQueueMessage, saveHostQueuedRunEdit } from "./queue-messages";
import {
  hostApprovalCard,
  hostApprovalResponder,
  sendHostApprovalFeedback,
  useHostApprovalResponses,
} from "./approval-requests";
import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { confirmComposerDispatch, submitThreadComposerMessage } from "../state/submit-thread-composer-message";
import { enqueueHostThreadMessage } from "./enqueue-thread-message";
import type { QueuedThreadMessage } from "../state/thread-outbox-model";
import { hostComposerDelivery } from "./composer-delivery";
import { backgroundTasks } from "./session-work";
import { submitNewTaskDraft } from "../features/threads/finish-draft-submission";
import type { ThreadDetailScreenProps } from "../features/threads/ThreadDetailScreen";
import { useAtomValue } from "@effect/atom-react";
import { useMessages } from "gt-react-native";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../state/preferences";
import type { ComposerEditorHandle } from "../components/ComposerEditor";
import { useThreadComposerInput } from "../state/use-thread-composer-input";
import type { QueueAttachment } from "@solus/contracts/session-queue";
import { isChat } from "@solus/contracts/chat";
import { questionTakesAttachments } from "@solus/contracts/question-answer";
import { useRememberThreadProject } from "../features/threads/useRememberThreadProject";
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
  resolveConversationImage,
} from "./ConversationMedia";
import { sessionFeed } from "./session-feed";

import { scopedThreadKey } from "../lib/scopedEntities";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { CommandId, EnvironmentId, MessageId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { isSessionBusyStatus, isSteerableStatus, requestExpiryText } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { hostFeedWork } from "./conversation-feed";
import {
  clearComposerDraft,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  composerContextImportsAtom,
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
import { threadKey } from "@solus-mobile/features/threads/thread-directory";
import { solus, useSolusWorkspace } from "./runtime";
import { toThreadShell } from "./session";
const wip = () => Alert.alert("WIP");
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
  const queuedMessages = useMemo(() => {
    const hostMessages = meta.queue.entries
      .filter((entry) => entry.kind !== "provider_switch")
      .map((entry) => hostQueueMessage(environmentId, threadId, entry, (path, refresh) =>
        resolveConversationImage(store, path, refresh).then((image) => image.uri),
      ));
    const pending = meta.pendingText;
    if (!pending || hostMessages.some((message) => message.messageId === pending.messageId)) return hostMessages;
    return [...hostMessages, {
      environmentId, threadId,
      messageId: MessageId.make(pending.messageId),
      commandId: CommandId.make(pending.commandId),
      createdAt: pending.createdAt,
      text: pending.text,
      attachments: [],
    }];
  }, [meta.pendingText, meta.queue.entries, environmentId, threadId, store]);
  const directory = useSolusWorkspace();
  const navigation = useNavigation();
  const [openedAt] = useState(Date.now);
  const listed = useSyncExternalStore(
    solus.threads.changes.subscribe,
    () => solus.threads.thread(hostId, id)?.record,
  );
  const listKey = threadKey(hostId, id);
  const view = useListened(solus.threadList.changes, () =>
    solus.threadList.facts().views.get(listKey) ?? listed?.view,
  );
  const state = useListened(solus.threadList.changes, () =>
    solus.threadList.facts().states.get(listKey) ?? listed?.state,
  );
  const busy = isSessionBusyStatus(meta.status);
  const { feed } = useAtomValue(sessionFeed(store));
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
    view,
    state,
  );
  const env = directory.environments.find((entry) => entry.environmentId === hostId);
  const firstPromptEditor = useRef<ComposerEditorHandle>(null);
  const showingDraft = isDraft && !meta.pendingText &&
    !feed.some((row) => row.type === "message" && row.message.role === "user");
  const detailRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const key = scopedThreadKey(environmentId, threadId);
  // A first prompt can already be on screen while its files save. Keep its
  // recoverable draft separate from text entered in the live thread.
  const inputKey = showingDraft ? draftKey ?? `draft:${key}` : key;
  const chooseDraftContext = (environment: boolean) => {
    const source =
      meta.attachments.length || meta.uploading ? { hostId, sessionId: id } : undefined;
    const saved =
      draftKey ??
      createNewTaskDraft({
        environmentId: shell.environmentId,
        projectId: shell.projectId,
        codebaseId: meta.run.isCodebasePicked ? meta.run.codebaseId : undefined,
      });
    if (!draftKey) {
      const draft = getComposerDraftSnapshot(inputKey);
      setComposerDraftText(saved, draft.text);
      setComposerDraftContext(saved, draft.context);
    }
    if (environment)
      navigation.navigate("NewTaskEnvironment", { draftId: saved, environmentId: hostId, source });
    else navigation.navigate("NewTaskProject", {
      draftId: saved,
      source,
      currentCodebase: { hostId, path: meta.run.projectDirectory, codebaseId: meta.run.codebaseId },
    });
  };
  const project = directory.projects.find(
    (p) => p.environmentId === hostId && p.id === shell.projectId,
  );
  useRememberThreadProject(project ?? null);
  const codebaseName = useListened(solus.codebases.changes, () => {
    if (meta.run.codebaseId) return solus.codebases.codebaseOf(meta.run.codebaseId)?.name;
    if (!project && !meta.run.isCodebasePicked)
      return solus.codebases.containerCodebaseAt(hostId, shell.projectId)?.name;
    return undefined;
  });
  const placeName = codebaseName ?? project?.title;
  const draftTitle =
    placeName ?? (isChat(meta.run.workingDirectory) ? "No project" : meta.run.workingDirectory);
  const {
    queuedRunEdit: edit, composerDraftKey: composerKey, currentDraftKey, beginQueuedEditSave,
    cancelQueuedRunEdit, onChangeDraftMessage, onRemoveQueuedEditAttachment, isSavingQueuedEdit,
  } = useThreadComposerInput(key, inputKey);
  const editedModel = edit?.hostModelSelection ?? edit?.hostInitialModel;
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
  const pickFiles = async (pick: typeof pickComposerFiles, onPreviewReady?: () => void) => {
    if (!controller.mayDrive) return false;
    if (edit && pickingEdit) return false;
    if (edit) setPickingEdit(true);
    return pick()
      .then(async (files) => {
        if (!files.length) return false;
        if (edit) {
          const uploads = await controller.uploadPickedFiles(files);
          onPreviewReady?.();
          if (currentEdit.current === edit.runId)
            setEditUploads((old) => [
              ...old,
              ...uploads.map((file, i) => ({ ...file, previewUri: files[i]!.uri })),
            ]);
        } else {
          onPreviewReady?.();
          await controller.attach(files);
        }
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
  const takesAttachments = question ? questionTakesAttachments(question) : false;
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
  useEffect(() => { facts?.ensure("capabilities"); }, [facts]);
  const hostCapabilities = useSyncExternalStore(
    useCallback((notify) => facts?.subscribe(notify) ?? (() => {}), [facts]),
    () => facts?.value("capabilities"),
  );
  const canUploadQuestionAttachments = controller.mayDrive && hostCapabilities?.attachUpload === true;
  const offersSideChat = !showingDraft && controller.mayDrive && hostCapabilities?.sessionComposer?.sideChatCommands === true;
  const attachmentDrafts = useAtomValue(
    questionAttachmentDraftsAtom(takesAttachments
      ? questionAttachmentDraftPrefix(environmentId, threadId, accountScope)
      : ""),
  );
  const preparations = useAtomValue(questionAttachmentPreparationAtom);
  const attachmentKeys = takesAttachments && pending
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
  const answerDrafts = takesAttachments && pending
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
  const fillOpeningHistory = meta.canFillOpeningHistory ? controller.fillOpeningHistory : undefined;
  const historyControls = useMemo(() => {
    const history = meta.history;
    if (!history.hasMoreHistory && history.error === null) return undefined;
    return {
      ...history,
      fillOpeningHistory,
      hasOpeningPage: meta.hasOpeningPage,
      onLoadEarlier: () => void controller.loadOlder(),
      onLoadThrough: (throughEntryId: string) => void controller.loadOlder(throughEntryId),
    };
  }, [meta.history, meta.hasOpeningPage, controller, fillOpeningHistory]);
  const connectionState = env?.connectionState ?? "offline";
  const loadError = meta.phase.kind === "error" ? meta.phase : null;
  const hasDetail = !loadError?.noAccess && (feed.length > 0 || meta.phase.kind === "ready");
  const detailError = loadError?.message ?? null;
  const resolve = useMessages();
  const contentPresentation = useMemo(
    () => projectThreadContentPresentation({
      hasDetail, detailError, detailDeleted: false, connectionState, resolve,
    }),
    [hasDetail, detailError, connectionState, resolve],
  );
  const editHostQueuedMessage = useCallback((message: QueuedThreadMessage) => {
    const entry = store.metaSnapshotOf().queue.entries.find(
      (item) => (item.clientPromptId ?? item.queueId) === message.messageId,
    );
    if (!entry) return false;
    return beginHostQueuedRunEdit(store, message, entry.queueId, (path, refresh) =>
      resolveConversationImage(store, path, refresh).then((image) => image.uri),
    );
  }, [store]);
  const syncStatus = useDelayedStatus(key, showingDraft || meta.phase.kind === "ready"
    ? null
    : threadSyncStatusLabel(feed.length ? "cached" : "synchronizing", contentPresentation.kind, loadError !== null));
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
    selectedThreadDetailRef: showingDraft ? null : detailRef,
    selectedThreadFeed: feed,
    screenTone: connectionTone(env?.connectionState ?? "offline"),
    connectionError: meta.phase.kind === "error" ? meta.phase.message : null,
    contentPresentation,
    historyControls,
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
    onChangeDraftMessage,
    onSendCommand: async (text) => {
      if (!controller.mayDrive) return null;
      const submission = controller.submit(text);
      await submission.delivered;
      return submission.messageId === null ? null : MessageId.make(submission.messageId);
    },
    onSendMessage: async (action, before, onWillEnqueue) => {
      const isCurrent = () => accountScope === solus.sessionCache.scope();
      if (!isCurrent() || composerKey !== currentDraftKey() || appAtomRegistry.get(composerContextImportsAtom)[composerKey]) return null;
      const draft = getComposerDraftSnapshot(composerKey);
      if (!edit && !before && parseSideChatCommand(draft.text) && !offersSideChat) {
        Alert.alert("Side chat not started", "This host does not support side chats.");
        return null;
      }
      const sameDraft = () =>
        isCurrent() &&
        sameComposerDraftState(draft, getComposerDraftSnapshot(composerKey));
      if (edit) {
        if (
          !controller.mayDrive ||
          pickingEdit ||
          (!draft.text.trim() && !draft.context?.records.length && !edit.existingAttachments.length && !editUploads.length)
        )
          return null;
        const finish = beginQueuedEditSave();
        if (!finish) return null;
        const scope = hostQueryScope(hostId);
        try {
          await saveHostQueuedRunEdit(store, edit, draft, editUploads.map(({ previewUri, ...file }) => file));
          const current = scope === hostQueryScope(hostId);
          if (!finish(current) || !current) return null;
          if (sameDraft()) setComposerDraftText(composerKey, "");
          return edit.messageId;
        } catch (error) {
          if (finish(false) && scope === hostQueryScope(hostId))
            Alert.alert("Could not edit queued message", String(error));
          return null;
        }
      }
      if (
        (!draft.text.trim() && !draft.context?.records.length && !controller.attachments.length && !controller.uploading) ||
        store.metaSnapshotOf().questions.some((question) => !question.expired)
      )
        return null;
      const permission = store.metaSnapshotOf().permissions.find((item) => !item.expired);
      if (before) {
        if (permission && approval?.requestId !== permission.questionId) return null;
        const proceed = await confirmComposerDispatch(
          composerKey, draft, before,
          Boolean(draft.context || controller.attachments.length || controller.uploading),
          sameDraft,
        );
        if (!proceed || permission) return null;
      } else if (permission) {
        if (!controller.mayApprove || draft.context || controller.attachments.length || controller.uploading)
          return null;
        if (await sendHostApprovalFeedback(permission, draft.text, respondToPermission) && sameDraft())
          setComposerDraftText(inputKey, "");
        return null;
      }
      if (!controller.mayDrive || !isCurrent()) return null;
      const metadata = makeQueuedMessageMetadata();
      const message: QueuedThreadMessage = {
        ...metadata,
        environmentId,
        threadId,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: draft.text.trim(),
        context: draft.context,
        attachments: draft.attachments,
        dispatchMode: hostComposerDelivery(store.metaSnapshotOf().status, followUpBehavior, action),
      };
      const report = (error: unknown) => {
        if (isCurrent()) Alert.alert("Send failed", error instanceof Error ? error.message : String(error));
      };
      const enqueue = (message: QueuedThreadMessage) => enqueueHostThreadMessage(controller, message, report);
      onWillEnqueue?.(message.messageId);
      if (showingDraft) {
        try {
          return await submitNewTaskDraft(navigation, inputKey, draft.text, message, enqueue, isCurrent);
        } catch (error) {
          report(error);
          return null;
        }
      }
      return submitThreadComposerMessage(inputKey, message, enqueue, {
        content: draft, isCurrent, onSaveError: report,
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
    editHostQueuedMessage: controller.mayDrive ? editHostQueuedMessage : null,
    dispatchingMessageId: meta.pendingText ? MessageId.make(meta.pendingText.messageId) : null,
    serverConfig: null,
    activePendingUserInput: pending,
    questionAttachmentAccess: takesAttachments
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
      : composerUploadMedia(id, meta.attachments, meta.pendingImages, meta.pendingVideos, meta.failedAttachments),
    hostAttachmentCount: edit
      ? editUploads.length + Number(pickingEdit)
      : meta.attachments.length + meta.uploading + meta.failedAttachments.length,
    onPickDraftMedia: async () => {
      await pickFiles(pickComposerMedia);
    },
    onPickDraftFiles: async () => {
      await pickFiles(pickComposerFiles);
    },
    onNativePasteImages: (uris, onPreviewReady) => pickFiles(() => pastedComposerImages(uris), onPreviewReady),
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
    ...hostFeedWork(feed, busy, Boolean(meta.pendingText)),
    isCompacting: meta.isCompacting,
    creationState: null,
    queuedRunEdit: edit,
    isSavingQueuedEdit,
    onCancelQueuedRunEdit: cancelQueuedRunEdit,
    onRemoveQueuedEditAttachment,
    canSwitchThreadProvider: controller.mayDrive && hostCapabilities?.sessionComposer?.providerSwitch !== false && !!meta.runOptions.agents?.some(agent =>
      agent.available !== false && agent.id !== meta.run.provider && isPickerProvider(agent.id) && !controller.policy.providerDenial(agent.id)),
    offersSideChat,
  } satisfies Omit<ThreadDetailScreenProps, "header">;
  return {
    binding,
    sessionFolders: meta.sessionFolders,
    draft: showingDraft
      ? {
          editorRef: firstPromptEditor,
          disabled: !controller.mayDrive,
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
        : syncStatus ?? [placeName, env?.environmentLabel].filter(Boolean).join(" · "),
      draft: showingDraft,
    },
  };
}
