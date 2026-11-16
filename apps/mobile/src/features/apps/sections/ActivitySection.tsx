import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";

import { AppTextInput } from "../../../components/AppText";

import { PillButton } from "../../webhooks/webhook-rows";
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
  searchOf,
  type CallFilters,
} from "../app-activity";
import { AppListRow, FilterChips, LoadedSection } from "../app-rows";
import { callState } from "../app-states";
import { callAgeText, callLines, callTitle } from "../apps";
import { useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/** How long the search waits for the typing to stop before it asks the host. */
const SEARCH_PAUSE_MS = 300;

/**
 * Activity (docs/plans/apps.md §9.2): the call log, newest first, narrowed
 * by a search and by operation, caller, and outcome. It holds the app's model
 * calls too (docs/plans/app-models.md). The mark of a row says how the call
 * ended. A call opens its detail; a model call opens its prompt, its text,
 * and its result.
 * The log is read again when the app's activity names its calls.
 * Platform exception (docs/plans/apps.md §9.2): no Activity chart, so no drag zoom on a touch device.
 */
export function ActivitySection({ hostId, appId, state, connected, navigation }: AppSectionProps) {
  const [filters, setFilters] = useState<CallFilters>(NO_CALL_FILTERS);
  const [limit, setLimit] = useState(CALL_PAGE_SIZE);
  const [searchText, setSearchText] = useState("");
  const { operation, callerKind, outcome, search } = filters;
  const readCalls = useCallback(
    (api: HostApi) => api.appCalls(callsRequest(appId, { operation, callerKind, outcome, search }, limit)),
    [appId, operation, callerKind, outcome, search, limit],
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

  // The host reads again when the typing stops, not on each key.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchOf(searchText);
      setFilters((current) => (current.search === next ? current : { ...current, search: next }));
      if (next !== search) setLimit(CALL_PAGE_SIZE);
    }, SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [searchText, search]);

  return (
    <>
      <View className="gap-2">
        <AppTextInput
          value={searchText}
          onChangeText={setSearchText}
          placeholder="Search calls"
          accessibilityLabel="Search operations, errors, inputs, and log lines"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          keyboardType={Platform.OS === "ios" ? "web-search" : "default"}
          returnKeyType="search"
          className="h-11 min-h-11 rounded-[22px] px-4 py-0 text-base leading-snug"
        />
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
        empty={hasCallFilters(filters) ? "No call matches this search and these filters." : "No calls yet."}
        note="The host keeps the newest 2,000 calls of each app, with the input, the log lines, and the trace of each one. It keeps no result and no secret."
        onRetry={calls.reload}
      >
        {(items) =>
          items.map((call, index) => (
            <AppListRow
              key={call.id}
              first={index === 0}
              mark={{ state: callState(call.outcome) }}
              title={callTitle(call)}
              trailing={callAgeText(call, now)}
              lines={callLines(call, namedWebhooks)}
              onPress={() =>
                call.kind === "model"
                  ? navigation.navigate("AppModelCall", { hostId, appId, callId: call.id })
                  : navigation.navigate("AppCall", { hostId, appId, callId: call.id })
              }
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
