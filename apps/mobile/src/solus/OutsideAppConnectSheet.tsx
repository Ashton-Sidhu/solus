import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { useListened } from "@solus-mobile/app/app-context";
import {
  addressToTest,
  isTunnelOnline,
  outsideAppGate,
  outsideAppGateMessage,
  type OutsideAppGate,
} from "@solus-mobile/features/settings/outside-app-gate";
import { publicAddressInput, shortAppAddress } from "@solus-mobile/features/settings/app-addresses";
import {
  APP_ACCESS_OPTIONS,
  appAccessLine,
  appAccessPhrase,
  appSetup,
  DEFAULT_APP_ACCESS,
  openFirstLink,
} from "@solus-mobile/features/settings/outside-app-setup";
import {
  appMakerLine,
  connectCode,
  newSignInOf,
} from "@solus-mobile/features/settings/outside-app-directory";
import { connectedApps, showsPairedDevices } from "@solus-mobile/features/settings/host-access";
import type { AppAccess, AppAddress } from "@solus/contracts/host-api";
import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { AppText, AppTextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { Menu } from "../components/ui/Menu";
import { Sheet } from "../components/ui/Sheet";
import { Toast } from "../components/ui/Toast";
import { cn } from "../lib/cn";
import { HostOperationError } from "./host-operation-error";
import { OutsideAppLogo } from "./OutsideAppLogo";
import { solus } from "./runtime";

/**
 * Connects one cloud app from the phone (plans/035 §10): the access switch, the
 * one button that hands the host's address to the app, the code the app asks
 * for, and a line that waits for the app to sign in. It opens only when the host
 * answers at an address the internet reaches (`outsideAppGate`); until then it
 * shows the ways to give the host one. With no app (`guide` null), it shows only
 * those ways: Sharing & access opens it so from "Anywhere".
 */

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
  readonly guide: OutsideAppGuide | null;
  readonly onClose: () => void;
}) {
  const { hostId, hostName, guide } = props;
  const insets = useSafeAreaInsets();
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host tests the address the app would use before the sheet opens
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
  return (
    <Sheet title={guide ? "Connect an app" : "Internet address"} onClose={props.onClose}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        {gate.kind !== "open" ? (
          <GateBody
            gate={gate}
            guide={guide}
            hostId={hostId}
            hostName={hostName}
            mayChangeHostSettings={mayChangeHostSettings}
            onCheckAgain={checkAgain}
            onBack={props.onClose}
          />
        ) : guide ? (
          <ConnectBody
            hostId={hostId}
            hostName={hostName}
            guide={guide}
            address={gate.address}
            notify={notify}
            onDone={props.onClose}
          />
        ) : (
          <AddressReady address={gate.address} hostName={hostName} onDone={props.onClose} />
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

/** The app's logo, "Connect Claude", and who makes it. */
function AppHeading(props: { readonly guide: OutsideAppGuide }) {
  return (
    <View className="flex-row items-center gap-3">
      <OutsideAppLogo logoId={props.guide.id} size={44} />
      <View className="min-w-0 flex-1 gap-px">
        <AppText accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
          Connect {props.guide.name}
        </AppText>
        <AppText className="text-sm text-foreground-muted">{appMakerLine(props.guide.id)}</AppText>
      </View>
    </View>
  );
}

function ConnectBody(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly guide: OutsideAppGuide;
  readonly address: AppAddress;
  readonly notify: Notify;
  readonly onDone: () => void;
}) {
  const { hostId, guide } = props;
  const [access, setAccess] = useState<AppAccess>(DEFAULT_APP_ACCESS);
  const state = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(hostId));
  const loaded = state.kind === "loaded" ? state : null;
  // What the host had when the sheet opened: only a code made since shows, and only a new grant counts as the sign-in.
  const [before] = useState(() => loaded?.appPair ?? null);
  const [known] = useState(
    () => new Set(loaded ? connectedApps(loaded.pairedDevices).map((app) => app.deviceId) : []),
  );
  // The access the last code was asked for; a ref, so a second run of the effect asks no second code.
  const requested = useRef<AppAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const code = connectCode({
    current: loaded?.appPair ?? null,
    before,
    access,
    isBusy: loaded?.busy === "app-pair",
    now,
  });
  const mint = (forAccess: AppAccess) => {
    requested.current = forAccess;
    setError(null);
    void solus.hostAccess
      .createAppPairCode(hostId, forAccess)
      .then(() => setNow(Date.now()))
      .catch((e) =>
        setError(`Could not get a code from ${props.hostName}. ${HostOperationError.from(e).message}`),
      );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each access the person picks gets its own code, made once
  useEffect(() => {
    if (requested.current !== access) mint(access);
  }, [access]);
  const isLive = code.kind === "live";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while a code works
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isLive]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the person comes back from the app after it signed in: read the grants again
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void solus.hostAccess.refreshPairedDevices(hostId);
    });
    return () => subscription.remove();
  }, [hostId]);
  // Only the owner reads the grants, so only the owner sees the sign-in arrive.
  const watchesSignIn = loaded !== null && showsPairedDevices(loaded.info);
  const signedIn = loaded ? newSignInOf(connectedApps(loaded.pairedDevices), guide, known) : null;
  return (
    <View className="gap-5">
      <AppHeading guide={guide} />
      {props.address.source === "tailscale-funnel" ? (
        <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-secondary">
          Tailscale Funnel address check passed.
        </AppText>
      ) : null}
      <View className="gap-1.5">
        <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
          <AppText className="text-base text-foreground-secondary">{guide.name} can</AppText>
          <Menu
            actions={APP_ACCESS_OPTIONS.map((option) => ({
              id: option.access,
              title: option.label,
              subtitle: appAccessLine(option.access, guide.name),
              state: option.access === access ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent: { event } }) => {
              const chosen = APP_ACCESS_OPTIONS.find((option) => option.access === event);
              if (chosen) setAccess(chosen.access);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`What ${guide.name} can do: ${appAccessPhrase(access)}`}
              className="min-h-9 flex-row items-center gap-1 rounded-lg bg-subtle px-2.5 active:opacity-70"
            >
              <AppText className="text-base font-t3-medium text-foreground">{appAccessPhrase(access)}</AppText>
              <AppText className="text-xs text-foreground-muted">▾</AppText>
            </Pressable>
          </Menu>
          <AppText className="text-base text-foreground-secondary">on {props.hostName}.</AppText>
        </View>
        <AppText className="text-sm text-foreground-muted">{appAccessLine(access, guide.name)}</AppText>
      </View>
      <HandOff guide={guide} publicUrl={props.address.url} notify={props.notify} />
      <CodeCard
        appName={guide.name}
        code={code}
        error={error}
        onNewCode={() => mint(access)}
        notify={props.notify}
      />
      {signedIn ? (
        <View className="gap-4">
          <StatusLine tone="done" text={`${guide.name} is connected.`} />
          <Button label="Done" tone="primary" fullWidth onPress={props.onDone} />
        </View>
      ) : watchesSignIn && isLive ? (
        <StatusLine tone="waiting" text={`Waiting for ${guide.name} to sign in`} />
      ) : null}
    </View>
  );
}

function StatusLine(props: { readonly tone: "waiting" | "done"; readonly text: string }) {
  return (
    <View accessibilityLiveRegion="polite" className="flex-row items-center justify-center gap-2">
      {props.tone === "done" ? (
        <View className="size-2 rounded-full bg-adaptive-emerald-600-400" />
      ) : (
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      )}
      <AppText
        className={cn(
          "text-sm",
          props.tone === "done" ? "text-adaptive-emerald-600-400" : "text-foreground-muted",
        )}
      >
        {props.text}
      </AppText>
    </View>
  );
}

/** Copies first, then opens the app: the app never gets an older clipboard. The notice keeps the web page within reach. */
function HandOff(props: {
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
        props.notify({
          message: "Could not copy",
          description: "Copy the address under Where apps reach this host.",
          tone: "danger",
        });
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

/** The code the app asks for on its sign-in page, with Copy and the time left. It is never copied or sent by itself. */
function CodeCard(props: {
  readonly appName: string;
  readonly code: ReturnType<typeof connectCode>;
  readonly error: string | null;
  readonly onNewCode: () => void;
  readonly notify: Notify;
}) {
  const { code } = props;
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-2xl bg-card px-4 py-3.5">
      <View className="min-w-0 flex-1 gap-1">
        <AppText className="text-xs font-t3-medium uppercase tracking-[1px] text-foreground-muted">
          Code for {props.appName}
        </AppText>
        {code.kind === "live" ? (
          <AppText
            selectable
            accessibilityLabel={`Code ${code.code}`}
            className="text-2xl font-t3-semibold tracking-[1.5px] text-foreground"
          >
            {code.code}
          </AppText>
        ) : props.error ? (
          <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
            {props.error}
          </AppText>
        ) : (
          <AppText className="text-base text-foreground-muted">
            {code.kind === "expired" ? "The code expired." : "Getting a code…"}
          </AppText>
        )}
      </View>
      {code.kind === "live" ? (
        <View className="items-end gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy code"
            hitSlop={8}
            onPress={() =>
              void Clipboard.setStringAsync(code.code)
                .then(() => props.notify({ message: "Code copied", tone: "success" }))
                .catch(() => props.notify({ message: "Could not copy", tone: "danger" }))
            }
          >
            <View className="rounded-lg bg-subtle px-3 py-1.5">
              <AppText className="text-sm font-t3-medium text-foreground">Copy</AppText>
            </View>
          </Pressable>
          <AppText className="text-xs text-foreground-muted">{code.timeLeft}</AppText>
        </View>
      ) : code.kind === "expired" || props.error ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={props.onNewCode}>
          <View className="rounded-lg bg-subtle px-3 py-1.5">
            <AppText className="text-sm font-t3-medium text-foreground">New code</AppText>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The ways to give the host an address the internet reaches, or why the host does not answer. */
function GateBody(props: {
  readonly gate: Exclude<OutsideAppGate, { kind: "open" }>;
  readonly guide: OutsideAppGuide | null;
  readonly hostId: string;
  readonly hostName: string;
  readonly mayChangeHostSettings: boolean;
  readonly onCheckAgain: () => void;
  readonly onBack: () => void;
}) {
  const message = outsideAppGateMessage(props.gate, props.hostName, {
    appName: props.guide?.name ?? null,
    mayChangeHostSettings: props.mayChangeHostSettings,
  });
  const lastWay = message.ways.length - 1;
  return (
    <View className="gap-5" accessibilityLiveRegion="polite">
      <View className="gap-2">
        {props.guide && props.gate.kind !== "checking" ? (
          <OutsideAppLogo logoId={props.guide.id} size={40} />
        ) : null}
        <View className="flex-row items-center gap-2">
          {props.gate.kind === "checking" ? (
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          ) : null}
          <AppText
            accessibilityRole={props.gate.kind === "checking" ? undefined : "header"}
            className={cn(
              "shrink text-foreground",
              props.gate.kind === "checking" ? "text-base font-t3-medium" : "text-xl font-t3-bold",
            )}
          >
            {message.title}
          </AppText>
        </View>
        {message.lines.map((line) => (
          <AppText key={line} className="text-base text-foreground-secondary">
            {line}
          </AppText>
        ))}
      </View>
      {message.ways.length > 0 ? (
        <View className="gap-3">
          {message.ways.map((way, index) => (
            <View key={way.label} className="gap-2.5 rounded-2xl bg-card px-4 py-3.5">
              <View className="gap-0.5">
                <AppText className="text-base text-foreground">{way.label}</AppText>
                <AppText className="text-sm text-foreground-muted">{way.detail}</AppText>
              </View>
              {index === lastWay && message.showsAddressField ? (
                <PublicAddressField hostId={props.hostId} onSaved={props.onCheckAgain} />
              ) : null}
            </View>
          ))}
        </View>
      ) : message.showsAddressField ? (
        <PublicAddressField hostId={props.hostId} onSaved={props.onCheckAgain} />
      ) : null}
      {message.canCheckAgain ? (
        <Button label="Check again" tone="primary" fullWidth onPress={props.onCheckAgain} />
      ) : null}
      {props.gate.kind !== "checking" ? <TextButton label="Back" onPress={props.onBack} /> : null}
    </View>
  );
}

/**
 * The person's own https address for the host (host setting `publicAddress`):
 * Save and Cancel while it is edited, and Remove, asked once, for a saved one.
 */
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
  const isEditing = draft !== null && draft.trim() !== saved;
  const write = (publicAddress: string) => {
    setIsSaving(true);
    void solus.hostSettings
      .update(props.hostId, { publicAddress })
      .then(() => {
        setDraft(null);
        setError(null);
        props.onSaved();
      })
      .catch((e) => setError(`Could not save the address. ${HostOperationError.from(e).message}`))
      .finally(() => setIsSaving(false));
  };
  const save = () => {
    const input = publicAddressInput(shown);
    if (!input.ok) {
      setError(input.message);
      return;
    }
    // An empty field is not a save: Remove takes the address away.
    if (input.value === "") return;
    write(input.value);
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  const remove = () =>
    Alert.alert(`Remove ${saved}?`, "Cloud apps that use it stop reaching this host.", [
      { text: "Keep", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => write("") },
    ]);
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <AppTextInput
          accessibilityLabel="Your own address"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          placeholder="https://"
          editable={!isSaving}
          value={shown}
          onChangeText={(text) => {
            setDraft(text);
            setError(null);
          }}
          onSubmitEditing={save}
          className="min-h-10 flex-1 rounded-lg bg-subtle-strong px-3 text-sm text-foreground"
        />
      </View>
      <View className="flex-row items-center justify-end gap-2">
        {!isEditing && saved !== "" ? (
          <Button label="Remove" tone="danger" size="compact" disabled={isSaving} onPress={remove} />
        ) : null}
        {isEditing ? (
          <Button label="Cancel" tone="secondary" size="compact" disabled={isSaving} onPress={cancel} />
        ) : null}
        <Button
          label={isSaving ? "Saving…" : "Save"}
          tone="primary"
          size="compact"
          disabled={isSaving || !isEditing || shown.trim() === ""}
          onPress={save}
        />
      </View>
      {error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

/** Shown when the sheet opened from "Anywhere" and the host now has an address. */
function AddressReady(props: {
  readonly address: AppAddress;
  readonly hostName: string;
  readonly onDone: () => void;
}) {
  return (
    <View className="gap-5">
      <View className="gap-2">
        <AppText accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
          Cloud apps can reach {props.hostName}
        </AppText>
        <AppText selectable className="text-base text-foreground-secondary">
          {shortAppAddress(props.address.url)}
        </AppText>
      </View>
      <Button label="Done" tone="primary" fullWidth onPress={props.onDone} />
    </View>
  );
}

function TextButton(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="items-center p-1.5 active:opacity-70"
    >
      <AppText className="text-base font-t3-medium text-foreground-secondary">{props.label}</AppText>
    </Pressable>
  );
}
