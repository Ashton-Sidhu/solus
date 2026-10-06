// Adapted from T3 Code apps/mobile/src/features/threads/PendingApprovalCard.tsx (card chrome) (MIT, see UPSTREAM.md).
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import type { AgentPlanAwaiting } from "../conversation/lib/agent-plans";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { RequestActionButton } from "./RequestActionButton";
import { ThreadMarkdown } from "./ThreadMarkdown";

type PlanItem = Extract<TranscriptItem, { kind: "plan" }>;

const PLAN_EYEBROW: Record<PlanItem["decision"], string> = {
  pending: "Plan ready for review",
  accepted: "Plan approved",
  rejected: "Changes requested",
  earlier: "Plan",
};

/** A short note field in T3's input style; Approve or Request changes send it. */
function PlanNoteInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
}) {
  return (
    <TextInput
      accessibilityLabel={props.placeholder}
      autoFocus={props.autoFocus}
      multiline
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName="accent-focus/32"
      cursorColorClassName="accent-focus"
      className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 font-sans text-sm text-foreground"
    />
  );
}

/**
 * A plan this session's agent proposed. Solus plan mode has no T3 equivalent
 * card; it wears the approval card's chrome. Approving starts the work in a
 * fresh run, as on desktop.
 */
export function ThreadPlanCard(props: { readonly store: ConversationStore; readonly plan: PlanItem }) {
  const { plan } = props;
  const pending = plan.decision === "pending";
  const [expanded, setExpanded] = useState(pending);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      if (approve) await props.store.controller.approvePlan(plan, note);
      else await props.store.controller.requestPlanChanges(plan, note);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="mb-5 gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {PLAN_EYEBROW[plan.decision]}
      </Text>
      {expanded ? (
        <ThreadMarkdown markdown={plan.content} tone="assistant" store={props.store} />
      ) : (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary" numberOfLines={3}>
          {plan.content}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        className="self-start active:opacity-70"
        hitSlop={6}
        onPress={() => setExpanded((value) => !value)}
      >
        <Text className="font-t3-bold text-xs text-foreground-muted">
          {expanded ? "Show less" : "Show the whole plan"}
        </Text>
      </Pressable>
      {pending ? (
        <>
          <PlanNoteInput value={note} onChangeText={setNote} placeholder="Notes for the agent (optional)" />
          <View className="flex-row flex-wrap gap-2.5">
            <RequestActionButton label="Approve" tone="primary" disabled={busy} onPress={() => void decide(true)} />
            <RequestActionButton
              label="Request changes"
              tone="secondary"
              disabled={busy}
              onPress={() => void decide(false)}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/**
 * A plan written by a session this one sent work to. Approving or asking for
 * changes acts on that session; this conversation sends nothing.
 */
export function AgentPlanCard(props: { readonly store: ConversationStore; readonly plan: AgentPlanAwaiting }) {
  const [revising, setRevising] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approve" | "request_changes") => {
    setBusy(true);
    try {
      await props.store.controller.decideAgentPlan(props.plan, decision, comment);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Plan from {props.plan.sessionTitle}
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">{props.plan.planTitle}</Text>
      {props.plan.content ? <ThreadMarkdown markdown={props.plan.content} tone="assistant" store={props.store} /> : null}
      {revising ? (
        <>
          <PlanNoteInput value={comment} onChangeText={setComment} placeholder="What should change?" autoFocus />
          <View className="flex-row flex-wrap gap-2.5">
            <RequestActionButton
              label="Send changes"
              tone="primary"
              disabled={busy || comment.trim().length === 0}
              onPress={() => void decide("request_changes")}
            />
            <RequestActionButton label="Cancel" tone="secondary" disabled={busy} onPress={() => setRevising(false)} />
          </View>
        </>
      ) : (
        <View className="flex-row flex-wrap gap-2.5">
          <RequestActionButton label="Approve" tone="primary" disabled={busy} onPress={() => void decide("approve")} />
          <RequestActionButton
            label="Request changes"
            tone="secondary"
            disabled={busy}
            onPress={() => setRevising(true)}
          />
        </View>
      )}
    </View>
  );
}
