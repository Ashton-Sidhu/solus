import { useRef, useState } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import { AppText } from "../components/ui/AppText";
import { Alert, Pressable, useWindowDimensions, View, ScrollView } from "react-native";
import { PendingApprovalCard } from "@solus-mobile/features/threads/PendingApprovalCard";
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
}: {
  store: ConversationStore;
  meta: ConversationMeta;
}) {
  const keyboardVisible = useKeyboardState((state) => state.height > 0);
  const maxHeight = useWindowDimensions().height * 0.48;
  const lock = useRef(false);
  const [responding, setResponding] = useState<string | null>(null);
  const permission = meta.permissions.find((p) => !p.expired) ?? meta.permissions[0];
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
  return (
    <>
      <ThreadMcpPipDock store={store} isKeyboardVisible={keyboardVisible} />
      {meta.attachments.length || meta.uploading ? (
        <View className="flex-row flex-wrap gap-2 px-4">
          {meta.attachments.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${a.name}`}
              onPress={() => store.controller.removeAttachment(a.id)}
            >
              <AppText className="rounded-xl bg-card px-3 py-2">{a.name} ×</AppText>
            </Pressable>
          ))}
          {meta.uploading > 0 && <AppText>Uploading {meta.uploading}…</AppText>}
        </View>
      ) : null}
      {permission || question?.kind === "secret" || meta.agentPlans.length ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          style={{ maxHeight }}
          contentContainerClassName="gap-2 px-4 pb-2"
        >
          {permission && (
            <PendingApprovalCard
              key={permission.questionId}
              approval={permission}
              respondingApprovalId={responding}
              mayDrive={store.controller.mayApprove}
              maxHeight={maxHeight}
              onRespond={(id, optionId) =>
                submit(id, () => store.controller.answerPermission(id, optionId))
              }
            />
          )}
          {question?.kind === "secret" && (
            <PendingSecretCard
              key={question.questionId}
              request={question}
              responding={responding !== null}
              mayDrive={store.controller.mayApprove}
              maxHeight={maxHeight}
              onSubmit={(values) =>
                submit(question.questionId, () =>
                  store.controller.answerSecretRequest(question.questionId, values),
                )
              }
            />
          )}
          {meta.agentPlans.map((plan) => (
            <PlanCard
              key={JSON.stringify([plan.targetSessionId, plan.messageId])}
              store={store}
              plan={plan}
            />
          ))}
        </ScrollView>
      ) : null}
    </>
  );
}
