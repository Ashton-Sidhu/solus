import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { hostReadinessCopy } from "@solus/client-core/host-readiness";
import { makeCheckCode } from "@solus-mobile/features/conversation/lib/add-machine-card";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { cn } from "../lib/cn";
import { AddSeveral, type AddOutcome } from "./add-several";
import { nearbyUrl } from "./discovery";
import { nearby, solus, useSolusWorkspace } from "./runtime";

export function NearbyHosts({
  onSelect,
  disabled,
  syncSettings,
}: {
  onSelect: (url: string, hostId: string) => void;
  disabled: boolean;
  /** Signed out: each host that Add adds takes this person's server settings (docs/plans/settings-sync-hosts.md). */
  syncSettings: boolean | null;
}) {
  const { environments } = useSolusWorkspace();
  const state = useSyncExternalStore(nearby.changes.subscribe, nearby.snapshot);
  const [batch] = useState(
    () => new AddSeveral(() => makeCheckCode(solus.platform.accountCrypto?.randomBytes)),
  );
  const added = useSyncExternalStore(batch.changes.subscribe, batch.snapshot);
  const [isSelecting, setIsSelecting] = useState(false);
  useEffect(() => {
    void nearby.scan();
  }, []);
  // Leaving the screen stops the requests that still wait.
  useEffect(() => () => batch.stop(), [batch]);
  if (!solus.canScanNearby) return null;
  const found = state.hosts.filter(
    (host) =>
      !environments.some(
        (env) => env.environmentId === host.installationId && env.connectionState === "connected",
      ),
  );
  const chosenCount = found.filter((host) => added.selected.has(host.installationId)).length;
  const selectable = found.filter((host) => added.outcomes.get(host.installationId)?.state !== "added");
  const isAllChosen =
    selectable.length > 0 && selectable.every((host) => added.selected.has(host.installationId));
  const add = () =>
    void batch.add(found, async (host, checkCode, signal) => {
      await solus.pairByApproval(
        { url: nearbyUrl(host), name: host.name, onTailnet: host.source === "tailnet" },
        checkCode,
        signal,
        syncSettings,
      );
    });
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-4 px-4">
        <AppText className="flex-1 font-t3-medium">Nearby hosts</AppText>
        {found.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            disabled={added.isRunning}
            onPress={() => setIsSelecting(!isSelecting)}
            className="min-h-11 justify-center"
          >
            <AppText>{isSelecting ? "Done" : "Select"}</AppText>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={state.scanning || added.isRunning}
          onPress={nearby.scan}
          className="min-h-11 justify-center"
        >
          <AppText>{state.scanning ? "Scanning…" : "Scan again"}</AppText>
        </Pressable>
      </View>
      {environments.map((env) => (
        <View key={env.environmentId} className="rounded-2xl bg-grouped-card px-4 py-3">
          <AppText>{env.environmentLabel}</AppText>
          <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {(({ label, detail }) => ["Paired", label, detail].filter(Boolean).join(" · "))(
              hostReadinessCopy(solus.connections.readiness(env.environmentId), env.environmentLabel),
            )}
          </AppText>
        </View>
      ))}
      {added.checkCode ? <CheckCodePanel checkCode={added.checkCode} onStop={() => batch.stop()} /> : null}
      {found.map((host) => (
        <FoundHostRow
          key={host.installationId}
          host={host}
          outcome={added.outcomes.get(host.installationId)}
          isSelecting={isSelecting}
          isChecked={added.selected.has(host.installationId)}
          isDisabled={disabled || state.scanning || added.isRunning}
          onToggle={() => batch.toggle(host.installationId)}
          onConnect={() => onSelect(nearbyUrl(host), host.installationId)}
        />
      ))}
      {isSelecting && found.length > 0 ? (
        <SelectActions
          isAllChosen={isAllChosen}
          chosenCount={chosenCount}
          isRunning={added.isRunning}
          isDisabled={disabled}
          hasSelectable={selectable.length > 0}
          onToggleAll={() => batch.toggleAll(found)}
          onAdd={add}
        />
      ) : null}
      {!state.scanning && !state.hosts.length && (!environments.length || state.error) && (
        <AppText className="px-4 text-sm text-foreground-muted">
          {state.error ?? "No unpaired hosts found."}
        </AppText>
      )}
    </View>
  );
}

/** The one check code every selected host shows while its request waits. */
function CheckCodePanel({ checkCode, onStop }: { checkCode: string; onStop: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" className="gap-2 rounded-2xl bg-grouped-card px-4 py-3">
      <AppText selectable accessibilityLabel={`Check code ${checkCode}`} className="font-mono text-2xl tracking-[2px] text-foreground">
        {checkCode}
      </AppText>
      <AppText className="text-sm text-foreground-muted">
        Approve the request in Solus on each machine. Approve only if it shows this code.
      </AppText>
      <Button label="Stop" tone="secondary" size="compact" onPress={onStop} />
    </View>
  );
}

function SelectActions(props: {
  isAllChosen: boolean;
  chosenCount: number;
  isRunning: boolean;
  isDisabled: boolean;
  hasSelectable: boolean;
  onToggleAll: () => void;
  onAdd: () => void;
}) {
  const { chosenCount, isRunning } = props;
  return (
    <View className="gap-2">
      <Button
        label={props.isAllChosen ? "Select none" : "Select all"}
        tone="text"
        size="compact"
        disabled={props.isDisabled || isRunning || !props.hasSelectable}
        onPress={props.onToggleAll}
      />
      <Button
        label={isRunning ? "Adding…" : `Add ${chosenCount} ${chosenCount === 1 ? "host" : "hosts"}`}
        tone="primary"
        fullWidth
        disabled={props.isDisabled || isRunning || chosenCount === 0}
        onPress={props.onAdd}
      />
    </View>
  );
}

/** One found host: a tap connects it, or, while selecting, adds it to the hosts added together. */
function FoundHostRow(props: {
  host: Parameters<typeof nearbyUrl>[0];
  outcome: AddOutcome | undefined;
  isSelecting: boolean;
  isChecked: boolean;
  isDisabled: boolean;
  onToggle: () => void;
  onConnect: () => void;
}) {
  const { host, outcome, isChecked } = props;
  const isDisabled = props.isDisabled || outcome?.state === "added";
  return (
    <Pressable
      accessibilityRole={props.isSelecting ? "checkbox" : "button"}
      accessibilityLabel={host.name}
      accessibilityState={props.isSelecting ? { checked: isChecked, disabled: isDisabled } : { disabled: isDisabled }}
      disabled={isDisabled}
      onPress={props.isSelecting ? props.onToggle : props.onConnect}
      className="gap-1 rounded-2xl bg-grouped-card px-4 py-3"
    >
      <AppText>
        {props.isSelecting && isChecked ? "✓ " : ""}
        {host.name}
      </AppText>
      <AppText className="text-sm text-foreground-muted">{nearbyUrl(host)}</AppText>
      <OutcomeLine outcome={outcome} />
    </Pressable>
  );
}

function OutcomeLine({ outcome }: { outcome: AddOutcome | undefined }) {
  if (!outcome) return null;
  return (
    <AppText
      accessibilityLiveRegion="polite"
      className={cn("text-sm", outcome.state === "failed" ? "text-danger-foreground" : "text-foreground-muted")}
    >
      {outcome.state === "waiting"
        ? "Waiting for approval…"
        : outcome.state === "added"
          ? "Added"
          : outcome.message}
    </AppText>
  );
}
