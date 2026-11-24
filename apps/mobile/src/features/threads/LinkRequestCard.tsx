import { useNavigation } from "@react-navigation/native";
import {
  rankAddMachineCandidates,
  type AddMachineCandidate,
} from "@solus/client-core/add-machine-candidates";
import { addMachineStatusCard } from "@solus/client-core/add-machine-progress";
import {
  addMachineOutcomeAnswers,
  PAIR_APPROVAL_TTL_MS,
  type AddMachineAsk,
  type AddMachineWay,
} from "@solus/contracts/add-machine";
import type { SshAddProgress, SshTargetCandidate } from "@solus/contracts/remote-machines";
import { requestExpiryText, type StatusCardState } from "@solus/contracts/types";
import {
  approveInstructions,
  attemptAddMachine,
  codeSteps,
  makeCheckCode,
  reachableMachines,
  stepFor,
  typedCodeError,
  typedCodeValue,
  watchSshProgress,
  wayLabel,
  type AddMachineAttempt,
  type AddMachineInput,
  type AddMachineStep,
} from "@solus-mobile/features/conversation/lib/add-machine-card";
import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { timeLeft } from "@solus-mobile/lib/time";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { openSettings } from "../settings/settings-navigation";
import { Button } from "../../components/ui/Button";
import { StepRail } from "../../components/ui/StepRail";
import { Sheet } from "../../components/ui/Sheet";
import { AddMachineSteps } from "./AddMachineSteps";
import { SyncSettingsChoice } from "../../solus/SyncSettingsRows";
import { nearbyUrl } from "../../solus/discovery";
import { nearby, solus, useSolusWorkspace } from "../../solus/runtime";

// Adapted from T3 Code's link request card: the same card, machine sheet, and
// step rail, answering a Solus Add machine card (`host-link`,
// docs/plans/add-machine-card.md). A code or a password lives only in this
// card's state and the one host call that uses it.

const ANOTHER_ADDRESS = "another-address";
const NO_ASK: AddMachineAsk = { reason: "" };
const MACHINE_SYMBOL: AppSymbolName = "desktopcomputer";

const failedAttempt = (message: string): AddMachineAttempt => ({ kind: "failed", message });

/** A host this phone is connected to, to make a code there. */
const readyApi = (serverId: string) =>
  solus.connections.state(serverId)?.readiness === "ready"
    ? (solus.connections.connection(serverId)?.api ?? null)
    : null;

/** One attempt on the session's host, which runs SSH and pairs. */
function attemptOnSessionHost(
  sessionHostId: string,
  step: AddMachineStep,
  input: AddMachineInput,
): Promise<AddMachineAttempt> {
  const session = solus.connections.connection(sessionHostId);
  if (!session) return Promise.resolve(failedAttempt("The session's host cannot be reached now."));
  const deviceLabel = solus.registry.host(sessionHostId)?.label ?? "Solus";
  return attemptAddMachine({ session: session.api, target: readyApi, deviceLabel }, step, input);
}

/** The add that runs, or the last one sent: what its setup steps show. */
interface SentAttempt {
  readonly id: string;
  readonly way: AddMachineWay;
  readonly name: string;
  readonly sshTarget?: string;
}

const wayOfStep = (step: AddMachineStep): AddMachineWay =>
  step.kind === "ssh" ? "ssh" : step.kind === "approve" ? "approve" : "code";

/** An approval request in progress: the card shows its check code until the target answers. */
interface WaitingApproval {
  readonly checkCode: string;
  readonly expiresAt: number;
  readonly name: string;
}

export function LinkRequestCard(props: {
  readonly question: PendingQuestion;
  readonly sessionHostId: string;
  readonly responding: boolean;
  /** False for a reader who may only view the session: an editor answers. */
  readonly mayDrive: boolean;
  /** Sends the card's answers to the host with `respondQuestion`. */
  readonly onAnswer: (answers: Record<string, string>) => Promise<void>;
}) {
  const ask = props.question.hostLink ?? NO_ASK;
  const [open, setOpen] = useState(false);
  const flow = useAddMachine(ask, props.sessionHostId, props.onAnswer, () => setOpen(false));
  const canRespond = props.question.expired === undefined;
  const busy = props.responding || flow.busy;
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">Add a machine</Text>
        {ask.reason.trim() ? (
          <Text selectable className="font-sans text-sm leading-5 text-foreground-muted">
            {ask.reason}
          </Text>
        ) : null}
      </View>
      {props.question.expired ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {requestExpiryText(props.question.expired)}
        </Text>
      ) : null}
      {flow.waiting ? <ApprovalWait waiting={flow.waiting} /> : null}
      {open ? null : <AttemptMessages statusCard={flow.statusCard} error={flow.error} />}
      {!canRespond ? null : props.mayDrive ? (
        <>
          <Button
            label={flow.busy ? "Adding…" : ask.url ? "Review machine…" : "Choose machine…"}
            disabled={busy}
            onPress={() => setOpen(true)}
            tone="primary"
            fullWidth
          />
          <View className="flex-row justify-end">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              hitSlop={8}
              className="px-1 py-1 active:opacity-60 disabled:opacity-50"
              onPress={() => void props.onAnswer(addMachineOutcomeAnswers({ status: "declined" }))}
            >
              <Text className="font-sans text-xs text-foreground-muted">Decline</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">Waiting for an editor</Text>
      )}
      {open ? (
        <AddMachineSheet
          flow={flow}
          disabled={busy}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** The check code and the time left of an approval request, on the card and in the sheet. */
function ApprovalWait(props: { readonly waiting: WaitingApproval }) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown that stops when the request ends
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View className="gap-1 rounded-xl border border-border bg-card p-3">
      <Text className="font-sans text-xs text-foreground-muted">
        Waiting for approval on {props.waiting.name} · {timeLeft(props.waiting.expiresAt, now)}
      </Text>
      <Text
        selectable
        accessibilityLabel={`Check code ${props.waiting.checkCode}`}
        className="font-mono text-2xl tracking-[2px] text-foreground"
      >
        {props.waiting.checkCode}
      </Text>
      <Text selectable className="font-sans text-xs leading-snug text-foreground-muted">
        {approveInstructions(props.waiting.name, props.waiting.checkCode)}
      </Text>
    </View>
  );
}

/** The machines the card offers: this phone's hosts, the session host's SSH targets, and nearby servers. */
function useCandidates(ask: AddMachineAsk, sessionHostId: string, isOpen: boolean) {
  const { environments } = useSolusWorkspace();
  const found = useSyncExternalStore(nearby.changes.subscribe, nearby.snapshot);
  const [ssh, setSsh] = useState<readonly SshTargetCandidate[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one read of the session host's SSH targets while the sheet is open
  useEffect(() => {
    if (!isOpen) return;
    let current = true;
    solus.connections
      .connection(sessionHostId)
      ?.api.hostsListSshConfigHosts()
      .then((targets) => current && setSsh(targets))
      // A host without SSH, or one that refuses this phone, offers no SSH rows.
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [isOpen, sessionHostId]);
  return useMemo(() => {
    const known = solus.registry.hosts().map((host) => ({
      hostId: host.id,
      label: host.label,
      routes: host.routes,
      isConnected: solus.connections.state(host.id)?.readiness === "ready",
      mayReach: solus.connections.may(host.id, "host.local.reach"),
    }));
    return rankAddMachineCandidates(ask, {
      reachable: reachableMachines(known, sessionHostId),
      ssh,
      nearby: found.hosts
        .filter((host) => host.installationId !== sessionHostId)
        .map((host) => ({ label: host.name, url: nearbyUrl(host) })),
    });
    // `environments` changes with the hosts and their connections.
  }, [ask, sessionHostId, ssh, found.hosts, environments]);
}

/** The state of one card: the selected row, the typed values, and the attempt in progress. */
function useAddMachine(
  ask: AddMachineAsk,
  sessionHostId: string,
  onAnswer: (answers: Record<string, string>) => Promise<void>,
  onAdded: () => void,
) {
  const [isOpen, setIsOpen] = useState(false);
  const candidates = useCandidates(ask, sessionHostId, isOpen);
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState(ask.url ?? "");
  const [useCode, setUseCode] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [needsAuth, setNeedsAuth] = useState<string | null>(null);
  const [mintRefused, setMintRefused] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sshSteps, setSshSteps] = useState<readonly SshAddProgress[]>([]);
  const [sent, setSent] = useState<SentAttempt | null>(null);
  const [waiting, setWaiting] = useState<WaitingApproval | null>(null);
  // Signed out: the new machine takes this person's server settings (docs/plans/settings-sync-hosts.md).
  const [syncSettings, setSyncSettings] = useState(true);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an answer that lands after the card closed changes nothing on screen
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const selectedKey = choice ?? candidates[0]?.key ?? ANOTHER_ADDRESS;
  const candidate = candidates.find((row) => row.key === selectedKey) ?? null;
  const step = stepFor(candidate, { address, useCode, mintRefused });
  const codeError = step?.kind === "code" ? typedCodeError(code) : null;
  // The sent attempt as setup steps, the rows a worktree setup draws: they run, then show where the add stopped.
  const statusCard: StatusCardState | null = useMemo(() => {
    if (!sent) return null;
    const standing = busy ? "running" : needsAuth !== null ? "needs-auth" : error !== null ? "failed" : null;
    if (!standing) return null;
    return addMachineStatusCard({
      attemptId: sent.id,
      way: sent.way,
      name: sent.name,
      sshTarget: sent.sshTarget,
      sshSteps,
      standing,
      error: needsAuth ?? error ?? "",
    });
  }, [sent, sshSteps, busy, needsAuth, error]);
  const ready =
    step !== null &&
    (step.kind !== "code" || typedCodeValue(code) !== null) &&
    (needsAuth === null || password.length > 0);

  const select = (key: string) => {
    setChoice(key);
    setUseCode(false);
    setNeedsAuth(null);
    setPassword("");
    setError(null);
    setSent(null);
  };

  const finish = (attempt: AddMachineAttempt) => {
    setBusy(false);
    setWaiting(null);
    if (attempt.kind === "added") return onAdded();
    if (attempt.kind === "needs-auth") return setNeedsAuth(attempt.message);
    setError(attempt.message);
    const refused = attempt.mintRefused;
    if (refused) setMintRefused((current) => new Set(current).add(refused));
  };

  const add = async () => {
    if (inFlight.current || !step || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNeedsAuth(null);
    setSshSteps([]);
    const requestId = solus.platform.uuid();
    setSent({ id: requestId, way: wayOfStep(step), name: step.name, sshTarget: step.kind === "ssh" ? step.sshTarget : undefined });
    const events = step.kind === "ssh" ? solus.connections.connection(sessionHostId)?.events : null;
    const stopProgress = events
      ? watchSshProgress(events, requestId, (event) => {
          if (mounted.current) setSshSteps((steps) => [...steps, event]);
        })
      : () => {};
    const checkCode =
      step.kind === "approve" ? makeCheckCode(solus.platform.accountCrypto?.randomBytes) : undefined;
    // The check code shows at once, so the person can compare it while the target asks.
    if (checkCode) setWaiting({ checkCode, expiresAt: Date.now() + PAIR_APPROVAL_TTL_MS, name: step.name });
    const input: AddMachineInput = { requestId, checkCode };
    if (step.kind === "code") input.code = typedCodeValue(code) ?? undefined;
    if (needsAuth !== null && password) input.authSecret = password;
    // No value is kept after it is sent.
    setCode("");
    setPassword("");
    const attempt = await attemptOnSessionHost(sessionHostId, step, input);
    stopProgress();
    if (attempt.kind === "added") {
      solus.settingsSync.hostAdded(attempt.outcome.installationId, syncSettings);
      await onAnswer(addMachineOutcomeAnswers(attempt.outcome));
    }
    inFlight.current = false;
    if (mounted.current) finish(attempt);
  };

  return {
    candidates,
    selectedKey,
    candidate,
    step,
    address,
    setAddress,
    useCode,
    setUseCode: (value: boolean) => {
      setUseCode(value);
      setError(null);
      setSent(null);
    },
    code,
    setCode,
    codeError,
    password,
    setPassword,
    needsAuth,
    busy,
    error,
    statusCard,
    waiting,
    ready,
    select,
    add,
    setIsOpen,
    syncSettings,
    setSyncSettings,
  };
}

type AddMachineFlow = ReturnType<typeof useAddMachine>;

function AddMachineSheet(props: {
  readonly flow: AddMachineFlow;
  readonly disabled: boolean;
  readonly onClose: () => void;
}) {
  const { flow } = props;
  const insets = useSafeAreaInsets();
  // The machine list reads the session host's SSH targets only while the sheet is open.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the card that its sheet is open
  useEffect(() => {
    flow.setIsOpen(true);
    return () => flow.setIsOpen(false);
  }, []);
  const step = flow.step;
  const offersCode =
    step?.kind === "approve" || (step?.kind === "ssh" && flow.candidate?.url !== undefined);
  // An SSH add or a code cannot be stopped once it is sent; an approval request waits on the card.
  const mayClose = !props.disabled || flow.waiting !== null;

  return (
    <Sheet
      title={step ? `Add ${step.name}` : "Add a machine"}
      onClose={props.onClose}
      dismissDisabled={!mayClose}
    >
      <ScrollView
        nestedScrollEnabled
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The session's host can then start, message, and wait on sessions there. It appears with
          the other paired devices on that machine, where it can be revoked.
        </Text>
        <MachineList flow={flow} disabled={props.disabled} />
        {flow.waiting ? <ApprovalWait waiting={flow.waiting} /> : null}
        {step?.kind === "code" ? (
          <CodeSteps flow={flow} step={step} disabled={props.disabled} onClose={props.onClose} />
        ) : null}
        <AttemptMessages statusCard={flow.statusCard} error={flow.error} />
        {step?.kind === "ssh" && flow.needsAuth !== null ? (
          <View className="gap-2">
            <TextInput
              accessibilityLabel={`SSH password for ${step.sshTarget}`}
              placeholder="Password or key passphrase"
              value={flow.password}
              onChangeText={flow.setPassword}
              editable={!props.disabled}
              secureTextEntry
              autoCorrect={false}
              autoCapitalize="none"
              autoComplete="off"
              textContentType="none"
              spellCheck={false}
            />
          </View>
        ) : null}
        <SyncSettingsChoice
          value={flow.syncSettings}
          onValueChange={flow.setSyncSettings}
          disabled={props.disabled}
        />
        <Button
          label={props.disabled ? "Adding…" : flow.error !== null ? "Try again" : "Add"}
          disabled={props.disabled || !flow.ready}
          onPress={() => void flow.add()}
          tone="primary"
          fullWidth
        />
        {offersCode || flow.useCode ? (
          <Button
            label={flow.useCode ? "Ask it to approve instead" : "Use a pairing code instead"}
            tone="secondary"
            disabled={props.disabled}
            onPress={() => flow.setUseCode(!flow.useCode)}
            fullWidth
          />
        ) : null}
        <Button
          label="Cancel"
          tone="secondary"
          disabled={!mayClose}
          onPress={props.onClose}
          fullWidth
        />
      </ScrollView>
    </Sheet>
  );
}

/** The ranked machines, then "Another address…" with its field. */
function MachineList(props: { readonly flow: AddMachineFlow; readonly disabled: boolean }) {
  const { flow } = props;
  const typesAddress = flow.selectedKey === ANOTHER_ADDRESS;
  return (
    <>
      <SettingsSection title="Machine">
        {flow.candidates.map((candidate, index) => (
          <MachineRow
            key={candidate.key}
            candidate={candidate}
            selected={flow.selectedKey === candidate.key}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() => flow.select(candidate.key)}
          />
        ))}
        <SettingsChoiceRow
          label="Another address…"
          description="Add a machine by its address on your network or tailnet."
          selected={typesAddress}
          separated={flow.candidates.length > 0}
          disabled={props.disabled}
          onPress={() => flow.select(ANOTHER_ADDRESS)}
        />
      </SettingsSection>
      {typesAddress ? (
        <TextInput
          accessibilityLabel="Address"
          placeholder="http://10.0.0.5:4810"
          value={flow.address}
          onChangeText={flow.setAddress}
          editable={!props.disabled}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType="url"
          spellCheck={false}
        />
      ) : null}
    </>
  );
}

/** Where to get a code on the target, a link to make one there when this phone reaches it, and the field. */
function CodeSteps(props: {
  readonly flow: AddMachineFlow;
  readonly step: Extract<AddMachineStep, { kind: "code" }>;
  readonly disabled: boolean;
  readonly onClose: () => void;
}) {
  const { flow, step } = props;
  const navigation = useNavigation();
  const serverId = flow.candidate?.serverId;
  const codeHostId =
    serverId && solus.connections.state(serverId)?.readiness === "ready" ? serverId : null;
  const hasCode = flow.code.trim().length > 0;
  return (
    <StepRail
      steps={[
        { title: `Make a code on ${step.name}`, hint: codeSteps(step.name), state: hasCode ? "done" : "current" },
        { title: "Enter the code here", state: hasCode ? "current" : "next" },
      ]}
      renderDetail={(_step, index) =>
        index === 0 && codeHostId ? (
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            className="mt-2 self-start active:opacity-60"
            onPress={() => {
              props.onClose();
              openSettings(navigation, "SettingsEnvironmentDetail", {
                environmentId: EnvironmentId.make(codeHostId),
                pairCode: "new",
              });
            }}
          >
            <Text className="font-t3-bold text-sm text-foreground underline">
              Show a code on {step.name}
            </Text>
          </Pressable>
        ) : index === 1 ? (
          <View className="mt-2 gap-1">
            <TextInput
              accessibilityLabel="Pairing code"
              placeholder="123456"
              value={flow.code}
              onChangeText={flow.setCode}
              editable={!props.disabled}
              autoCorrect={false}
              autoCapitalize="none"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              spellCheck={false}
            />
            {flow.codeError ? (
              <Text className="font-sans text-xs text-danger-foreground">{flow.codeError}</Text>
            ) : null}
          </View>
        ) : null
      }
    />
  );
}

/** The steps of the sent add, or why the last attempt failed when nothing was sent. */
function AttemptMessages(props: { readonly statusCard: StatusCardState | null; readonly error: string | null }) {
  return (
    <>
      {props.statusCard ? <AddMachineSteps card={props.statusCard} /> : null}
      {props.statusCard === null && props.error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {props.error}
        </Text>
      ) : null}
    </>
  );
}

/** One machine in the sheet's list: its name, its address or SSH target, and its way. */
function MachineRow(props: {
  readonly candidate: AddMachineCandidate;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { candidate } = props;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.separated
          ? "flex-row items-center gap-3 border-t border-border-subtle p-4 active:opacity-70"
          : "flex-row items-center gap-3 p-4 active:opacity-70"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView
        name={MACHINE_SYMBOL}
        size={18}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>
          {candidate.label}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {candidate.detail}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {wayLabel(candidate)}
        </Text>
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

