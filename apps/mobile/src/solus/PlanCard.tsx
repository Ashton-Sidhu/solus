import { ProposedPlanView } from "../features/threads/ProposedPlanView";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { AgentPlanAwaiting } from "@solus-mobile/features/conversation/lib/agent-plans";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import { RequestActionButton } from "@solus-mobile/features/threads/RequestActionButton";
import { useMarkdownStyles } from "../features/threads/ThreadFeed";
import { SelectableMarkdownText } from "../native/SelectableMarkdownText";
import { AppText, AppTextInput } from "../components/ui/AppText";

export function PlanCard({
  store,
  plan,
  history = false,
}: {
  store: ConversationStore;
  history?: boolean;
  plan: Extract<TranscriptItem, { kind: "plan" }> | AgentPlanAwaiting;
}) {
  const styles = useMarkdownStyles();
  const child = "targetSessionId" in plan;
  const pending = child || plan.decision === "pending";
  const [expanded, setExpanded] = useState(pending && !history);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const decide = async (approve: boolean) => {
    const controller = store.controller;
    if (!controller.mayApprove || sending.current || !pending) return;
    sending.current = true;
    setBusy(true);
    try {
      const accepted = child
        ? await controller.decideAgentPlan(plan, approve ? "approve" : "request_changes", note)
        : approve
          ? await controller.approvePlan(plan, note)
          : await controller.requestPlanChanges(plan, note);
      if (accepted) setNote("");
    } catch {
      Alert.alert("Could not send plan decision", "Check the host connection and try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <ProposedPlanView
      markdown={plan.content}
      title={child ? plan.planTitle : undefined}
      renderMarkdown={(markdown) =>
        expanded ? (
          <SelectableMarkdownText
            markdown={markdown}
            textStyle={styles.assistant.nativeTextStyle}
          />
        ) : (
          <AppText numberOfLines={3}>{markdown}</AppText>
        )
      }
    >
      <AppText className="text-xs text-foreground-muted">
        {child ? plan.sessionTitle : plan.decision}
      </AppText>
      <RequestActionButton
        label={expanded ? "Show less" : "Show full plan"}
        tone="secondary"
        onPress={() => setExpanded(!expanded)}
      />
      {pending &&
        !history &&
        (store.controller.mayApprove ? (
          <>
            <AppTextInput
              accessibilityLabel="Notes for the agent"
              placeholder="Notes for the agent"
              value={note}
              onChangeText={setNote}
              multiline
            />
            <View className="flex-row flex-wrap gap-2">
              <RequestActionButton
                label="Approve"
                disabled={busy}
                onPress={() => void decide(true)}
              />
              <RequestActionButton
                label="Request changes"
                tone="secondary"
                disabled={busy || !note.trim()}
                onPress={() => void decide(false)}
              />
            </View>
          </>
        ) : (
          <AppText>Waiting for an editor</AppText>
        ))}
    </ProposedPlanView>
  );
}
