import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { useListened } from "@solus-mobile/app/app-context";
import {
  addressToTest,
  appAddressNote,
  isTunnelOnline,
  outsideAppGate,
  outsideAppGateMessage,
  type OutsideAppGate,
} from "@solus-mobile/features/settings/outside-app-gate";
import { publicAddressInput } from "@solus-mobile/features/settings/app-addresses";
import {
  APP_ACCESS_OPTIONS,
  appAccessLabel,
  appCodeExpiry,
  appSetup,
  DEFAULT_APP_ACCESS,
  openFirstLink,
  OTHER_APP_NOTE,
  OTHER_APP_STEPS,
  PHONE_APP_GUIDES,
} from "@solus-mobile/features/settings/outside-app-setup";
import type { HostAppPairCode } from "@solus-mobile/features/settings/host-access";
import type { AppAccess, AppAddress } from "@solus/contracts/host-api";
import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { ListChoiceRow } from "../components/ui/ListChoiceRow";
import { ListRow } from "../components/ui/ListRow";
import { ListSection } from "../components/ui/ListSection";
import { Sheet } from "../components/ui/Sheet";
import { Toast } from "../components/ui/Toast";
import { ConnectionFormField } from "../features/connection/ConnectionFormField";
import { cn } from "../lib/cn";
import { HostOperationError } from "./host-operation-error";
import { outsideAppLogo } from "./outside-app-logos";
import { solus } from "./runtime";

/**
 * Connect an outside app from the phone, in the steps of the desktop and web
 * flow: App → Access → Connect (plans/035 §10). The steps show only when the
 * host answers at an address that the internet reaches (`outsideAppGate`): the
 * phone offers the apps that run in the cloud, and it is never the host machine.
 */

type Step = 0 | 1 | 2;
const STEPS: readonly { step: Step; label: string }[] = [
  { step: 0, label: "App" },
  { step: 1, label: "Access" },
  { step: 2, label: "Connect" },
];
type Choice = OutsideAppGuide | "other";
type Notice = {
  readonly message: string;
  readonly description?: string;
  readonly tone: "success" | "danger";
  readonly action?: { readonly label: string; readonly onPress: () => void };
};
type Notify = (notice: Notice) => void;

export function OutsideAppConnectSheet(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly onClose: () => void;
}) {
  const { hostId, hostName } = props;
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [access, setAccess] = useState<AppAccess>(DEFAULT_APP_ACCESS);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hostAccess = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const cloudLink = useListened(solus.hostCloudLink.changes, () =>
    solus.hostCloudLink.stateOf(hostId),
  );
  const addressTest = useListened(solus.hostAccess.changes, () =>
    solus.hostAccess.addressTestOf(hostId),
  );
  const mayChangeHostSettings = useListened(solus.connections.changes, () =>
    solus.connections.may(hostId, "host.admin"),
  );
  const gate = outsideAppGate({ access: hostAccess, cloudLink, addressTest });
  // A new read of the host drops the last test of its address, so the address is tested again.
  const checkAgain = () => {
    void solus.hostAccess.load(hostId);
    void solus.hostCloudLink.load(hostId);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host's app addresses once the sheet opens
  useEffect(checkAgain, [hostId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the person's own address is a host setting, which the field shows
  useEffect(() => {
    if (mayChangeHostSettings) void solus.hostSettings.load(hostId);
  }, [hostId, mayChangeHostSettings]);
  const isOnline = isTunnelOnline(cloudLink);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a tunnel that came online gives the host a Solus address to read
  useEffect(() => {
    if (isOnline) void solus.hostAccess.load(hostId);
  }, [hostId, isOnline]);
  const pending = addressToTest(gate, hostAccess);
  const testUrl = pending !== null && addressTest?.url !== pending.url ? pending.url : null;
  const testSource = pending?.source ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host tests the address the app would use before the steps open
  useEffect(() => {
    if (testUrl !== null && testSource !== null) {
      void solus.hostAccess.testAppAddress(hostId, { source: testSource, url: testUrl });
    }
  }, [hostId, testUrl, testSource]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the notice timer when the sheet closes
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const notify: Notify = (next) => {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = setTimeout(() => setNotice(null), 5_000);
  };
  const appName = choice === null || choice === "other" ? null : choice.name;
  return (
    <Sheet title="Connect an app" onClose={props.onClose}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        {gate.kind !== "open" ? (
          <GateScreen
            gate={gate}
            hostId={hostId}
            hostName={hostName}
            mayChangeHostSettings={mayChangeHostSettings}
            onCheckAgain={checkAgain}
          />
        ) : (
          <>
            <StepBar step={step} onStep={setStep} />
            {step === 0 ? (
              <AppStep
                onChoose={(next) => {
                  setChoice(next);
                  setStep(1);
                }}
              />
            ) : step === 1 ? (
              <View className="gap-4">
                <ListSection
                  title={appName ? `What can ${appName} do?` : "What can the app do?"}
                >
                  {APP_ACCESS_OPTIONS.map((option, index) => (
                    <ListChoiceRow
                      key={option.access}
                      label={option.label}
                      description={option.effect}
                      selected={option.access === access}
                      separated={index > 0}
                      onPress={() => setAccess(option.access)}
                    />
                  ))}
                </ListSection>
                <View className="flex-row gap-3">
                  <Button label="Back" onPress={() => setStep(0)} />
                  <View className="flex-1">
                    <Button label="Next" tone="primary" fullWidth onPress={() => setStep(2)} />
                  </View>
                </View>
              </View>
            ) : choice !== null ? (
              <View className="gap-5">
                <ConnectStep
                  hostId={hostId}
                  hostName={hostName}
                  address={gate.address}
                  choice={choice}
                  access={access}
                  notify={notify}
                />
                <Button label="Done" tone="primary" fullWidth onPress={props.onClose} />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      {notice ? (
        <View
          className="absolute inset-x-3 z-[100]"
          style={{ bottom: insets.bottom + 12 }}
          pointerEvents="box-none"
        >
          <Toast
            message={notice.message}
            description={notice.description}
            tone={notice.tone}
            action={notice.action}
            onDismiss={() => setNotice(null)}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

/** Where the person is in the steps; an earlier step opens again on tap. */
function StepBar(props: { readonly step: Step; readonly onStep: (step: Step) => void }) {
  return (
    <View className="flex-row gap-4" accessibilityRole="tablist">
      {STEPS.map(({ step, label }) => (
        <Pressable
          key={label}
          accessibilityRole="tab"
          accessibilityState={{ selected: step === props.step, disabled: step > props.step }}
          disabled={step >= props.step}
          onPress={() => props.onStep(step)}
        >
          <AppText
            className={cn(
              "text-sm",
              step === props.step ? "font-t3-medium text-foreground" : "text-foreground-muted",
            )}
          >
            {step + 1}. {label}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

function GateScreen(props: {
  readonly gate: Exclude<OutsideAppGate, { kind: "open" }>;
  readonly hostId: string;
  readonly hostName: string;
  readonly mayChangeHostSettings: boolean;
  readonly onCheckAgain: () => void;
}) {
  const message = outsideAppGateMessage(props.gate, props.hostName, {
    mayChangeHostSettings: props.mayChangeHostSettings,
  });
  return (
    <View className="gap-3" accessibilityLiveRegion="polite">
      <View className="flex-row items-center gap-2">
        {props.gate.kind === "checking" ? (
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        ) : null}
        <AppText
          accessibilityRole={props.gate.kind === "checking" ? undefined : "header"}
          className="shrink text-base font-t3-medium text-foreground"
        >
          {message.title}
        </AppText>
      </View>
      {message.lines.map((line) => (
        <AppText key={line} className="text-sm text-foreground-muted">
          {line}
        </AppText>
      ))}
      {message.ways.map((way, index) => (
        <View key={way.label} className="gap-1 rounded-xl bg-grouped-card px-4 py-3">
          <AppText className="text-sm font-t3-medium text-foreground">
            {index + 1}. {way.label}
          </AppText>
          <AppText className="text-sm text-foreground-muted">{way.detail}</AppText>
        </View>
      ))}
      {message.showsAddressField ? (
        <PublicAddressField hostId={props.hostId} onSaved={props.onCheckAgain} />
      ) : null}
      {message.canCheckAgain ? <Button label="Check again" onPress={props.onCheckAgain} /> : null}
    </View>
  );
}

/** The person's own https address for the host (host setting `publicAddress`). Empty removes it. */
function PublicAddressField(props: { readonly hostId: string; readonly onSaved: () => void }) {
  const settings = useListened(solus.hostSettings.changes, () =>
    solus.hostSettings.stateOf(props.hostId),
  );
  const saved = settings.kind === "loaded" ? (settings.settings.publicAddress ?? "") : null;
  const [draft, setDraft] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (saved === null) {
    return (
      <AppText className="text-sm text-foreground-muted">
        {settings.kind === "error" ? settings.message : "Reading the host settings…"}
      </AppText>
    );
  }
  const shown = draft ?? saved;
  const save = () => {
    const input = publicAddressInput(shown);
    if (!input.ok) {
      setError(input.message);
      return;
    }
    setIsSaving(true);
    void solus.hostSettings
      .update(props.hostId, { publicAddress: input.value })
      .then(() => {
        setDraft(null);
        setError(null);
        props.onSaved();
      })
      .catch((e) => setError(`Could not save the address. ${HostOperationError.from(e).message}`))
      .finally(() => setIsSaving(false));
  };
  return (
    <View className="gap-2">
      <ConnectionFormField
        label="Your own address"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        placeholder="https://solus.example.com"
        editable={!isSaving}
        value={shown}
        onChangeText={(text) => {
          setDraft(text);
          setError(null);
        }}
        onSubmitEditing={save}
      />
      {error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </AppText>
      ) : null}
      <Button
        label={isSaving ? "Saving…" : "Save address"}
        tone="primary"
        disabled={isSaving || draft === null || draft.trim() === saved}
        onPress={save}
      />
    </View>
  );
}

/** An app's logo in a small rounded tile, as T3 Code's picker shows it. */
function AppLogo(props: { readonly guideId: string }) {
  const logo = outsideAppLogo(props.guideId);
  if (!logo) return null;
  return <Image source={logo} accessibilityIgnoresInvertColors style={{ width: 28, height: 28, borderRadius: 8 }} />;
}

/** The cloud apps of the catalog, and any other app that adds a remote MCP server. */
function AppStep(props: { readonly onChoose: (choice: Choice) => void }) {
  return (
    <View className="gap-4">
      <ListSection title="Which app?">
        {PHONE_APP_GUIDES.map((guide, index) => (
          <View key={guide.id} className={cn(index > 0 && "border-t border-border-subtle")}>
            <ListRow label={guide.name} leading={<AppLogo guideId={guide.id} />} onPress={() => props.onChoose(guide)} />
          </View>
        ))}
      </ListSection>
      <ListSection>
        <ListRow
          icon="ellipsis.circle"
          label="Something else…"
          onPress={() => props.onChoose("other")}
        />
      </ListSection>
    </View>
  );
}

function ConnectStep(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly address: AppAddress;
  readonly choice: Choice;
  readonly access: AppAccess;
  readonly notify: Notify;
}) {
  const [anotherWay, setAnotherWay] = useState(false);
  const app = props.choice === "other" ? null : props.choice;
  const note = app?.note ?? null;
  const code = (
    <ApprovalCode
      hostId={props.hostId}
      hostName={props.hostName}
      access={props.access}
      notify={props.notify}
    />
  );
  const publicUrl = props.address.url;
  const address = (
    <AddressRow address={props.address} app={app} hostName={props.hostName} notify={props.notify} />
  );
  if (app === null || anotherWay) {
    const handoff = app?.handoff;
    const message = handoff?.kind === "copy-message" ? handoff.message(publicUrl) : null;
    const docs = app?.docs;
    return (
      <View className="gap-4">
        {address}
        {message ? <CopyRow label="Message" value={message} notify={props.notify} /> : null}
        <View className="gap-2">
          {(app?.steps ?? OTHER_APP_STEPS).map((step, index) => (
            <AppText key={step} className="text-sm text-foreground">
              {index + 1}. {step}
            </AppText>
          ))}
        </View>
        {app === null ? <Hint>{OTHER_APP_NOTE}</Hint> : note ? <Hint>{note}</Hint> : null}
        {app && docs ? (
          <TextAction
            label={`${app.name} help`}
            onPress={() =>
              void Linking.openURL(docs).catch(() =>
                props.notify({ message: "Could not open the link", description: docs, tone: "danger" }),
              )
            }
          />
        ) : null}
        {code}
        {app ? <TextAction label="Back to one tap" onPress={() => setAnotherWay(false)} /> : null}
      </View>
    );
  }
  return (
    <View className="gap-4">
      <PrimaryAction guide={app} publicUrl={publicUrl} notify={props.notify} />
      {note ? <Hint>{note}</Hint> : null}
      {address}
      {code}
      <TextAction label="Set up another way" onPress={() => setAnotherWay(true)} />
    </View>
  );
}

/** The address the app uses, with Copy, and where the address comes from. */
function AddressRow(props: {
  readonly address: AppAddress;
  readonly app: OutsideAppGuide | null;
  readonly hostName: string;
  readonly notify: Notify;
}) {
  return (
    <View className="gap-2">
      <CopyRow label="Address" value={props.address.url} notify={props.notify} />
      <Hint>{appAddressNote(props.address, props.app?.name ?? null, props.hostName)}</Hint>
    </View>
  );
}

/** Copies first, then opens the app: the app never gets an older clipboard. The notice keeps the web page within reach. */
function PrimaryAction(props: {
  readonly guide: OutsideAppGuide;
  readonly publicUrl: string;
  readonly notify: Notify;
}) {
  const setup = appSetup(props.guide, props.publicUrl);
  if (setup.kind !== "ready") return null;
  const { action } = setup;
  const name = props.guide.name;
  const openPage = (page: string) =>
    void Linking.openURL(page).catch(() =>
      props.notify({ message: `Could not open ${name}`, description: page, tone: "danger" }),
    );
  const handOff = async () => {
    if (action.copyText !== null) {
      const isCopied = await Clipboard.setStringAsync(action.copyText).catch(() => false);
      if (!isCopied) {
        props.notify({ message: "Could not copy", description: "Use Set up another way.", tone: "danger" });
        return;
      }
      const page = action.page;
      props.notify({
        message: action.copiedNotice ?? "Copied",
        tone: "success",
        action: page
          ? { label: action.links.length > 1 ? `Get ${name}` : `Open ${name}`, onPress: () => openPage(page) }
          : undefined,
      });
    }
    if (action.links.length === 0) return;
    await openFirstLink(action.links, (url) => Linking.openURL(url)).catch((e) =>
      props.notify({
        message: `Could not open ${name}`,
        description: HostOperationError.from(e).message,
        tone: "danger",
      }),
    );
  };
  return <Button label={action.label} tone="primary" fullWidth onPress={() => void handOff()} />;
}

/** "Get code" makes a code on tap, for the access the person chose. It is never copied or sent by itself. */
function ApprovalCode(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly access: AppAccess;
  readonly notify: Notify;
}) {
  const state = useListened(solus.hostAccess.changes, () =>
    solus.hostAccess.stateOf(props.hostId),
  );
  const current = state.kind === "loaded" ? state.appPair : null;
  const isBusy = state.kind === "loaded" && state.busy === "app-pair";
  // The code on the host before the tap: only a code made after it shows. Undefined until the tap.
  const [before, setBefore] = useState<HostAppPairCode | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const code =
    before !== undefined && !isBusy && current !== before && current?.access === props.access
      ? current
      : null;
  const expiry = code ? appCodeExpiry(code.expiresAt, now) : null;
  const isLive = expiry !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while a code works
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isLive]);
  const mint = () => {
    setBefore(current);
    setError(null);
    void solus.hostAccess
      .createAppPairCode(props.hostId, props.access)
      .then(() => setNow(Date.now()))
      .catch((e) =>
        setError(`Could not get a code from ${props.hostName}. ${HostOperationError.from(e).message}`),
      );
  };
  return (
    <View className="gap-2 rounded-xl bg-grouped-card px-4 py-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <AppText className="text-sm text-foreground">
          Code to approve{" "}
          <AppText className="text-sm font-t3-medium text-foreground">
            {appAccessLabel(props.access)}
          </AppText>
        </AppText>
        {expiry === null ? (
          <Button
            label={isBusy ? "Getting code…" : code ? "New code" : "Get code"}
            size="compact"
            disabled={isBusy}
            onPress={mint}
          />
        ) : null}
      </View>
      {code ? (
        expiry !== null ? (
          <>
            <View className="flex-row items-center gap-2">
              <AppText
                selectable
                accessibilityLabel={`Pairing code ${code.code}`}
                className="flex-1 font-mono text-2xl tracking-[2px] text-foreground"
              >
                {code.code}
              </AppText>
              <IconButton
                icon="doc.on.doc"
                accessibilityLabel="Copy code"
                onPress={() =>
                  void Clipboard.setStringAsync(code.code)
                    .then(() => props.notify({ message: "Code copied", tone: "success" }))
                    .catch(() => props.notify({ message: "Could not copy", tone: "danger" }))
                }
              />
            </View>
            <AppText className="text-sm text-foreground-muted">{expiry}</AppText>
          </>
        ) : (
          <AppText className="text-sm text-foreground-muted">The code expired.</AppText>
        )
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

function CopyRow(props: { readonly label: string; readonly value: string; readonly notify: Notify }) {
  return (
    <View className="flex-row items-center gap-3 rounded-xl bg-grouped-card py-2 pl-4 pr-2">
      <AppText className="shrink-0 text-sm text-foreground-muted">{props.label}</AppText>
      <AppText selectable numberOfLines={1} className="min-w-0 flex-1 font-mono text-sm text-foreground">
        {props.value}
      </AppText>
      <IconButton
        icon="doc.on.doc"
        accessibilityLabel={`Copy ${props.label.toLowerCase()}`}
        onPress={() =>
          void Clipboard.setStringAsync(props.value)
            .then(() => props.notify({ message: `${props.label} copied`, tone: "success" }))
            .catch(() => props.notify({ message: "Could not copy", tone: "danger" }))
        }
      />
    </View>
  );
}

function Hint(props: { readonly children: ReactNode }) {
  return <AppText className="text-sm text-foreground-muted">{props.children}</AppText>;
}

function TextAction(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <View className="items-start">
      <Button label={props.label} tone="text" onPress={props.onPress} />
    </View>
  );
}
