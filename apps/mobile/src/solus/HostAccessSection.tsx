import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import type { PairApprovalDecision } from "@solus/contracts/add-machine";
import { useListened } from "@solus-mobile/app/app-context";
import { canChangeAccess, hasPairing } from "@solus-mobile/features/settings/host-access";
import { timeLeft } from "@solus-mobile/lib/time";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { solus } from "./runtime";

/**
 * A host's pairing code and its open approval requests
 * (docs/plans/add-machine-card.md). `makeCode` is the link from an Add machine
 * card: the page makes a code once it can.
 */
export function HostAccessSection({
  hostId,
  isConnected,
  makeCode,
}: {
  hostId: string;
  isConnected: boolean;
  makeCode: boolean;
}) {
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const approvals = useListened(solus.pairApprovals.changes, () =>
    solus.pairApprovals.approvalsOf(hostId),
  );
  const deciding = useListened(solus.pairApprovals.changes, () => solus.pairApprovals.deciding);
  const madeCode = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isConnected) void solus.hostAccess.load(hostId);
  }, [hostId, isConnected]);
  const mayPair =
    access.kind === "loaded" && hasPairing(access.info) && canChangeAccess(access.info);
  const pair = access.kind === "loaded" ? access.pair : null;
  const isCounting = (pair !== null && pair.expiresAt > now) || approvals.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while a code or a request is open
  useEffect(() => {
    if (!isCounting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isCounting]);
  const generate = () =>
    void solus.hostAccess
      .generatePairCode(hostId)
      .catch((error: unknown) => Alert.alert("Could not make a code", String(error)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the link from an Add machine card makes one code when the page can
  useEffect(() => {
    if (!makeCode || !mayPair || madeCode.current) return;
    madeCode.current = true;
    generate();
  }, [makeCode, mayPair]);
  const decide = (requestId: string, decision: PairApprovalDecision) =>
    void solus.pairApprovals
      .decide(hostId, requestId, decision)
      .then((done) => {
        if (!done)
          Alert.alert("Request no longer waiting", "It expired or was answered elsewhere.");
      })
      .catch((error: unknown) =>
        Alert.alert(
          decision === "approve" ? "Could not approve the device" : "Could not deny the device",
          String(error),
        ),
      );
  const openApprovals = approvals.filter((request) => request.expiresAt > now);
  if (!mayPair && openApprovals.length === 0) return null;
  return (
    <>
      {mayPair ? (
        <SettingsSection title="Pairing code">
          {pair && pair.expiresAt > now ? (
            <View className="gap-1 px-4 py-3">
              <AppText
                selectable
                accessibilityLabel={`Pairing code ${pair.code}`}
                className="font-mono text-2xl tracking-[2px] text-foreground"
              >
                {pair.code}
              </AppText>
              <AppText className="text-sm text-foreground-muted">
                {timeLeft(pair.expiresAt, now)} · Enter it on the machine that adds this one.
              </AppText>
            </View>
          ) : null}
          <SettingsRow
            icon="link"
            label={pair && pair.expiresAt > now ? "Generate new code" : "Generate code"}
            disabled={access.kind === "loaded" && access.busy === "pair"}
            onPress={generate}
          />
        </SettingsSection>
      ) : null}
      {openApprovals.length > 0 ? (
        <SettingsSection title="Approval requests">
          {openApprovals.map((request) => (
            <View key={request.requestId} className="gap-2 px-4 py-3">
              <AppText className="text-foreground">{request.deviceLabel}</AppText>
              <AppText selectable className="text-sm text-foreground-muted">
                Check code {request.checkCode} · {request.fromAddress} ·{" "}
                {timeLeft(request.expiresAt, now)}
              </AppText>
              <AppText className="text-sm text-foreground-muted">
                Approve it only if the other machine shows the same check code.
              </AppText>
              <View className="flex-row gap-2">
                <Button
                  label="Deny"
                  tone="secondary"
                  size="compact"
                  disabled={deciding.has(request.requestId)}
                  onPress={() => decide(request.requestId, "deny")}
                />
                <Button
                  label="Approve"
                  tone="primary"
                  size="compact"
                  disabled={deciding.has(request.requestId)}
                  onPress={() => decide(request.requestId, "approve")}
                />
              </View>
            </View>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
