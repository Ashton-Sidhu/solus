import { useCallback, useState } from "react";
import { View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";

import { PillButton, WebhookListRow } from "../../webhooks/webhook-rows";
import {
  CALL_PAGE_SIZE,
  CALLER_CHOICES,
  callsRequest,
  canShowOlderCalls,
  hasCallFilters,
  NO_CALL_FILTERS,
  olderCallsLimit,
  operationChoices,
  OUTCOME_CHOICES,
  type CallFilters,
} from "../app-activity";
import { FilterChips, LoadedSection } from "../app-rows";
import { callAgeText, callLines } from "../apps";
import { useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Activity (docs/plans/apps.md §9.2): the call log, newest first, narrowed
 * by operation, caller, and outcome. A call opens its detail. The log is read
 * again when the app's activity names its calls.
 */
export function ActivitySection({ hostId, appId, state, connected, navigation }: AppSectionProps) {
  const [filters, setFilters] = useState<CallFilters>(NO_CALL_FILTERS);
  const [limit, setLimit] = useState(CALL_PAGE_SIZE);
  const { operation, callerKind, outcome } = filters;
  const readCalls = useCallback(
    (api: HostApi) => api.appCalls(callsRequest(appId, { operation, callerKind, outcome }, limit)),
    [appId, operation, callerKind, outcome, limit],
  );
  const calls = useAppRead(hostId, appId, "calls", readCalls);
  // The webhooks name a webhook caller; the log shows without them.
  const readWebhooks = useCallback((api: HostApi) => api.appWebhooks({ appId }), [appId]);
  const webhooks = useAppRead(hostId, appId, "webhooks", readWebhooks);
  const namedWebhooks = webhooks.state.kind === "loaded" ? webhooks.state.value : [];
  const now = Date.now();

  /** A new filter starts at the newest page again. */
  const narrow = (next: CallFilters) => {
    setFilters(next);
    setLimit(CALL_PAGE_SIZE);
  };

  return (
    <>
      <View className="gap-2">
        <FilterChips
          label="Filter by outcome"
          choices={OUTCOME_CHOICES}
          selected={outcome}
          onSelect={(value) => narrow({ ...filters, outcome: value })}
        />
        <FilterChips
          label="Filter by caller"
          choices={CALLER_CHOICES}
          selected={callerKind}
          onSelect={(value) => narrow({ ...filters, callerKind: value })}
        />
        <FilterChips
          label="Filter by operation"
          choices={operationChoices(state.descriptor)}
          selected={operation}
          onSelect={(value) => narrow({ ...filters, operation: value })}
        />
      </View>
      <LoadedSection
        title="Calls"
        read={calls.state}
        connected={connected}
        subject="The call log"
        empty={hasCallFilters(filters) ? "No call passes these filters." : "No calls yet."}
        note="The host keeps the newest 2,000 calls of each app, with the input, the log lines, and the trace of each one. It keeps no result and no secret."
        onRetry={calls.reload}
      >
        {(items) =>
          items.map((call, index) => (
            <WebhookListRow
              key={call.id}
              first={index === 0}
              title={call.operation}
              trailing={callAgeText(call, now)}
              lines={callLines(call, namedWebhooks)}
              onPress={() => navigation.navigate("AppCall", { hostId, appId, callId: call.id })}
            />
          ))
        }
      </LoadedSection>
      {calls.state.kind === "loaded" && canShowOlderCalls(calls.state.value.length, limit) ? (
        <PillButton label="Show older calls" onPress={() => setLimit(olderCallsLimit(limit))} />
      ) : null}
    </>
  );
}
