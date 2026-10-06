// Adapted from T3 Code apps/mobile/src/features/threads/PendingApprovalCard.tsx (MIT, see UPSTREAM.md).
import { RequestActionButton } from "./RequestActionButton";
import { requestExpiryText, type PermissionOption } from "@solus/contracts/types";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingPermission } from "../conversation/lib/transcript-model";

export interface PendingApprovalCardProps {
  readonly approval: PendingPermission;
  readonly respondingApprovalId: string | null;
  readonly onRespond: (questionId: string, optionId: string) => Promise<unknown>;
}

/**
 * T3's tones on Solus options: the first allow (once) is primary, a wider
 * allow (for the session) secondary, and deny or reject danger.
 */
function optionTone(option: PermissionOption, firstAllowId: string | null): "primary" | "secondary" | "danger" {
  const kind = option.kind ?? "";
  if (kind === "deny" || kind.startsWith("reject")) return "danger";
  return option.id === firstAllowId ? "primary" : "secondary";
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  // Opaque: nothing blurs the feed behind this card, so a translucent surface
  // bleeds messages through it.
  const canRespond = props.approval.expired === undefined;
  const disabled = !canRespond || props.respondingApprovalId === props.approval.questionId;
  const firstAllowId =
    props.approval.options.find((option) => option.kind?.startsWith("allow"))?.id ??
    props.approval.options[0]?.id ??
    null;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">{props.approval.toolName}</Text>
      {props.approval.description ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.description}
        </Text>
      ) : null}
      {props.approval.expired ? (
        <Text className="font-sans text-sm leading-5 text-adaptive-neutral-600-400">
          {requestExpiryText(props.approval.expired)}
        </Text>
      ) : null}
      {canRespond ? (
        <View className="flex-row flex-wrap gap-2.5">
          {props.approval.options.map((option) => (
            <RequestActionButton
              key={option.id}
              label={option.label}
              tone={optionTone(option, firstAllowId)}
              disabled={disabled}
              onPress={() => void props.onRespond(props.approval.questionId, option.id)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
