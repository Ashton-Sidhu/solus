import { useNavigation } from "@react-navigation/native";
import { attachmentRoute } from "./upload-attachment-id";
import { useRef, useState } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import { AppText } from "../components/ui/AppText";
import { Alert, Pressable, View } from "react-native";
import { ApprovalCardView } from "../features/threads/PendingApprovalCard";
import { LinkRequestCard } from "../features/threads/LinkRequestCard";
import { requestExpiryText } from "@solus/contracts/types";
import { PendingSecretCard } from "@solus-mobile/features/threads/PendingSecretCard";
import { ThreadMcpPipDock } from "@solus-mobile/features/threads/ThreadMcpPipDock";
import type {
  ConversationMeta,
  ConversationStore,
} from "@solus-mobile/features/conversation/conversation-store";
import { PlanCard } from "./PlanCard";

export function RequestCards({
  store,
  meta,
  draft,
}: {
  store: ConversationStore;
  meta: ConversationMeta;
  draft: boolean;
}) {
  const navigation = useNavigation();
  const keyboardVisible = useKeyboardState((state) => state.height > 0);
  const fileChips = meta.attachments.filter(
    (a) => !a.localUri && !(a.kind === "image" && a.dataUrl),
  );
  const pendingFileCount = meta.uploading - meta.pendingImages.length - meta.pendingVideos.length;
  return (
    <>
      <ThreadMcpPipDock store={store} isKeyboardVisible={keyboardVisible} />
      {fileChips.length || pendingFileCount ? (
        <View className="flex-row flex-wrap gap-2 px-4">
          {fileChips.map((a) => (
            <View key={a.id} className="flex-row items-center rounded-xl bg-card">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={a.name}
                onPress={() =>
                  navigation.navigate(draft ? "NewTaskAttachment" : "ThreadAttachment", {
                    ...attachmentRoute(
                      store.controller.hostId,
                      store.controller.run.sessionId,
                      a.hostPath,
                      a.name,
                      a.mimeType,
                      a.size,
                    ),
                    hostUploadId: a.id,
                  })
                }
              >
                <AppText className="px-3 py-2">{a.name}</AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${a.name}`}
                onPress={() => store.controller.removeAttachment(a.id)}
              >
                <AppText className="px-2 py-2">×</AppText>
              </Pressable>
            </View>
          ))}
          {pendingFileCount > 0 && <AppText>Uploading {pendingFileCount}…</AppText>}
        </View>
      ) : null}
    </>
  );
}

export function RequestPanels({
  store,
  meta,
  showPermission = true,
  respondToPermission,
  respondingPermissionId,
}: {
  store: ConversationStore;
  meta: ConversationMeta;
  showPermission?: boolean;
  respondToPermission?: (requestId: string, optionId: string) => Promise<boolean>;
  respondingPermissionId?: string | null;
}) {
  const lock = useRef(false);
  const [responding, setResponding] = useState<string | null>(null);
  const permission = showPermission
    ? meta.permissions.find((p) => !p.expired) ?? meta.permissions[0]
    : undefined;
  const question = meta.questions.find((q) => !q.expired) ?? meta.questions[0];
  const submit = async (id: string, answer: () => Promise<boolean>) => {
    if (lock.current || !store.controller.mayApprove) return;
    lock.current = true;
    setResponding(id);
    try {
      await answer();
    } catch {
      Alert.alert("Could not send response", "Check the host connection and try again.");
    } finally {
      lock.current = false;
      setResponding(null);
    }
  };
  const firstAllow =
    permission?.options.find((option) => option.kind?.startsWith("allow"))?.id ??
    permission?.options[0]?.id;
  const answerPermission = (id: string, optionId: string) =>
    submit(id, () => respondToPermission
      ? respondToPermission(id, optionId)
      : store.controller.answerPermission(id, optionId));
  return (
    <>
      {permission ? (
        <ApprovalCardView
          key={permission.questionId}
          title={permission.toolName}
          detail={permission.description ?? undefined}
          reason={permission.guestTurn ? "Guest turn · Ask mode" : undefined}
          canRespond={!permission.expired}
          expiredReason={permission.expired ? requestExpiryText(permission.expired) : undefined}
          mayApprove={store.controller.mayApprove}
          disabled={responding !== null || Boolean(respondingPermissionId)}
          options={permission.options.map((option) => ({
            id: option.id,
            label: option.label,
            tone:
              option.kind === "deny" || option.kind?.startsWith("reject")
                ? "danger"
                : option.id === firstAllow
                  ? "primary"
                  : "secondary",
            respond: () => answerPermission(permission.questionId, option.id),
          }))}
        />
      ) : null}
      {question?.kind === "secret" && (
        <PendingSecretCard
          key={question.questionId}
          request={question}
          responding={responding !== null}
          mayDrive={store.controller.mayApprove}
          onSubmit={(values) =>
            submit(question.questionId, () =>
              store.controller.answerSecretRequest(question.questionId, values),
            )
          }
        />
      )}
      {question?.kind === "host-link" && (
        <LinkRequestCard
          key={question.questionId}
          question={question}
          sessionHostId={store.controller.hostId}
          responding={responding !== null}
          mayDrive={store.controller.mayApprove}
          onAnswer={(answers) =>
            submit(question.questionId, () =>
              store.controller.answerQuestion(question.questionId, answers),
            )
          }
        />
      )}
      {meta.pendingPlan && (
        <PlanCard key={meta.pendingPlan.id} store={store} plan={meta.pendingPlan} />
      )}
      {meta.agentPlans.map((plan) => (
        <PlanCard
          key={JSON.stringify([plan.targetSessionId, plan.messageId])}
          store={store}
          plan={plan}
        />
      ))}
    </>
  );
}
