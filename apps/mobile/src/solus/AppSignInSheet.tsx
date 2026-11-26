import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import * as Linking from "expo-linking";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useListened } from "@solus-mobile/app/app-context";
import {
  APP_SIGN_IN_WARNING,
  appSignInDetails,
  appSignInDoneMessage,
  appSignInTimeLeft,
  NO_HOST_MESSAGE,
  type AppSignInState,
} from "@solus-mobile/features/settings/app-sign-in";
import type { AppSignInRequest } from "@solus/contracts/host-api";
import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { AppText, AppTextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { Sheet } from "../components/ui/Sheet";
import { solus } from "./runtime";

/**
 * Approves an outside app's sign-in on the phone (plans/035 §0.5). The camera opens
 * the sign-in page's `solus://approve-app` link here; "Approve a sign-in" on a host's
 * Use Solus in other apps section opens the code entry. `solus.appSignIns` keeps
 * the one sign-in on screen.
 */
// The link that started the app opens once, not again when the coordinator mounts again.
let isInitialLinkRead = false;

export function AppSignInCoordinator() {
  const state = useListened(solus.appSignIns.changes, () => solus.appSignIns.state);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the link that started the app, and each link that arrives while it runs, opens its sign-in
  useEffect(() => {
    if (!isInitialLinkRead) {
      isInitialLinkRead = true;
      void Linking.getInitialURL().then((url) => {
        if (url) solus.appSignIns.openLink(url);
      });
    }
    const subscription = Linking.addEventListener("url", ({ url }) => solus.appSignIns.openLink(url));
    return () => subscription.remove();
  }, []);
  if (state.kind === "closed") return null;
  const isDeciding = state.kind === "open" && state.deciding !== null;
  return (
    <Sheet title="Approve a sign-in" dismissDisabled={isDeciding} onClose={() => solus.appSignIns.close()}>
      <AppSignInBody state={state} />
    </Sheet>
  );
}

function AppSignInBody(props: { readonly state: Exclude<AppSignInState, { kind: "closed" }> }) {
  const insets = useSafeAreaInsets();
  const { state } = props;
  return (
    <ScrollView
      className="flex-1 bg-sheet-solid"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-4 p-5"
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
    >
      {state.kind === "finding-host" || state.kind === "loading" ? (
        <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
          <AppText className="text-sm text-foreground-muted">
            {state.kind === "finding-host" ? "Finding the host…" : "Reading the sign-in…"}
          </AppText>
        </View>
      ) : state.kind === "no-host" ? (
        <Outcome message={NO_HOST_MESSAGE} />
      ) : state.kind === "entering-code" ? (
        <CodeEntry error={state.error} />
      ) : state.kind === "read-failed" ? (
        <View className="gap-3">
          <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
            {state.message}
          </AppText>
          <Button label="Try again" onPress={() => solus.appSignIns.retry()} />
        </View>
      ) : state.kind === "open" ? (
        <Request request={state.request} deciding={state.deciding} error={state.error} />
      ) : (
        <Outcome message={appSignInDoneMessage(state)} />
      )}
    </ScrollView>
  );
}

/** The check code from the app's sign-in page. */
function CodeEntry(props: { readonly error: string | null }) {
  const [code, setCode] = useState("");
  const submit = () => solus.appSignIns.submitCode(code);
  return (
    <View className="gap-3">
      <AppText className="text-sm text-foreground-muted">
        Type the code that the app's sign-in page shows after you choose Approve in Solus.
      </AppText>
      <AppTextInput
        accessibilityLabel="Check code"
        placeholder="ABCD-2345"
        value={code}
        onChangeText={setCode}
        onSubmitEditing={submit}
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        returnKeyType="next"
        className="font-mono text-lg tracking-[2px]"
      />
      {props.error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </AppText>
      ) : null}
      <Button label="Next" tone="primary" fullWidth disabled={code.trim() === ""} onPress={submit} />
    </View>
  );
}

function Request(props: {
  readonly request: AppSignInRequest;
  readonly deciding: "approve" | "deny" | null;
  readonly error: string | null;
}) {
  const { request } = props;
  const [now, setNow] = useState(() => Date.now());
  const timeLeft = appSignInTimeLeft(request.expiresAt, now);
  const isLive = timeLeft !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second countdown while the sign-in waits
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isLive]);
  const details = appSignInDetails(request);
  return (
    <View className="gap-4">
      <View className="gap-1">
        <AppText accessibilityRole="header" className="text-lg font-t3-medium text-foreground">
          {request.appName}
        </AppText>
        <AppText className="text-sm text-foreground">{details.place}</AppText>
        {details.computer ? (
          <AppText className="text-sm text-foreground-muted">{details.computer}</AppText>
        ) : null}
      </View>
      <View className="gap-1 rounded-xl bg-grouped-card px-4 py-3">
        <AppText className="text-sm font-t3-medium text-foreground">{details.access}</AppText>
        <AppText className="text-sm text-foreground-muted">{details.effect}</AppText>
      </View>
      <AppText className="text-sm text-foreground-muted" accessibilityLiveRegion="polite">
        {timeLeft ?? "This sign-in expired. Start it again in the app."}
      </AppText>
      <AppText className="text-sm text-foreground">{APP_SIGN_IN_WARNING}</AppText>
      {props.error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </AppText>
      ) : null}
      <View className="flex-row gap-3">
        <Button
          label="Deny"
          loading={props.deciding === "deny"}
          disabled={props.deciding !== null}
          onPress={() => void solus.appSignIns.decide("deny")}
        />
        <View className="flex-1">
          <Button
            label="Approve"
            tone="primary"
            fullWidth
            loading={props.deciding === "approve"}
            disabled={props.deciding !== null || !isLive}
            onPress={() => void solus.appSignIns.decide("approve")}
          />
        </View>
      </View>
    </View>
  );
}

function Outcome(props: { readonly message: string }) {
  return (
    <View className="gap-4">
      <AppText accessibilityLiveRegion="polite" className="text-base text-foreground">
        {props.message}
      </AppText>
      <Button label="Done" tone="primary" fullWidth onPress={() => solus.appSignIns.close()} />
    </View>
  );
}
