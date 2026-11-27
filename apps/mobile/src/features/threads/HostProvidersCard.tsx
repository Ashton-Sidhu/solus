import { useNavigation } from "@react-navigation/native";
import { hostProvidersSkipAnswers, type HostProvidersAsk } from "@solus/contracts/add-machine";
import { SETUP_AGENT_SEAT_PROVIDERS } from "@solus/contracts/seats";
import { requestExpiryText } from "@solus/contracts/types";
import {
  cardTitle,
  pastePrompt,
  PROVIDER_ICON_IDS,
  type SignInPhase,
} from "@solus-mobile/features/conversation/lib/host-providers-card";
import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { useListened } from "@solus-mobile/app/app-context";
import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { solus } from "../../solus/runtime";
import { openSettings } from "../settings/settings-navigation";

// The Sign in card of `add_host` (question kind `host-providers`,
// docs/host-provider-sign-in.md), with the parts of the Add machine card: the
// card with its reason, a full-width action, and a quiet "Not now". The phone
// signs in here, in its browser, with the new host's seat RPCs; the host keeps
// the account. The session host closes the card when the host reports the
// sign-in, so the card has no "done" step of its own.

export function HostProvidersCard(props: {
  readonly question: PendingQuestion;
  readonly ask: HostProvidersAsk;
  readonly responding: boolean;
  /** False for a reader who may only view the session: an editor answers. */
  readonly mayDrive: boolean;
  /** Sends the card's answer to the host with `respondQuestion`. */
  readonly onAnswer: (answers: Record<string, string>) => Promise<void>;
}) {
  const { ask } = props;
  const navigation = useNavigation();
  // On the phone a host's id is its installation id.
  const hostId = ask.installationId;
  const isReachable = useListened(
    solus.connections.changes,
    () => solus.connections.readiness(hostId).readiness === "ready",
  );
  const [phase, setPhase] = useState<SignInPhase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canRespond = props.question.expired === undefined;
  const provider = SETUP_AGENT_SEAT_PROVIDERS[ask.provider];

  async function startSignIn() {
    const api = solus.connections.connection(hostId)?.api;
    if (!api) return;
    setError(null);
    setPhase({ kind: "starting" });
    try {
      const verification = await api.seatConnectStart({ provider });
      setPhase({ kind: "browser", verification });
      await tryOpenExternalUrl(verification.verificationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase({ kind: "idle" });
    }
  }

  async function sendCode() {
    const api = solus.connections.connection(hostId)?.api;
    if (!api || phase.kind !== "browser" || !code.trim()) return;
    setError(null);
    setPhase({ kind: "sending", verification: phase.verification });
    try {
      await api.seatConnectSubmitCode({ provider, code: code.trim() });
      setCode("");
      setPhase({ kind: "finishing" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase({ kind: "browser", verification: phase.verification });
    }
  }

  const verification = phase.kind === "browser" || phase.kind === "sending" ? phase.verification : null;
  const prompt = verification ? pastePrompt(verification) : null;

  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <ProviderIcon provider={PROVIDER_ICON_IDS[ask.provider]} size={18} />
          <Text className="flex-1 font-t3-bold text-base text-foreground">{cardTitle(ask)}</Text>
        </View>
        <Text selectable className="font-sans text-sm leading-5 text-foreground-muted">
          {ask.reason} The account stays on {ask.hostName}.
        </Text>
      </View>
      {props.question.expired ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {requestExpiryText(props.question.expired)}
        </Text>
      ) : null}
      {!canRespond ? null : !props.mayDrive ? (
        <Text className="font-sans text-xs text-foreground-muted">Waiting for an editor</Text>
      ) : (
        <>
          {!isReachable ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              Connecting to {ask.hostName}…
            </Text>
          ) : phase.kind === "idle" || phase.kind === "starting" ? (
            <Button
              label={phase.kind === "starting" ? "Opening the sign-in page…" : "Sign in"}
              disabled={props.responding || phase.kind === "starting"}
              onPress={() => void startSignIn()}
              tone="primary"
              fullWidth
            />
          ) : phase.kind === "finishing" ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              Finishing your sign-in on {ask.hostName}…
            </Text>
          ) : (
            <View className="gap-2">
              {verification?.userCode ? (
                <Text selectable className="font-t3-bold text-lg tracking-widest text-foreground">
                  {verification.userCode}
                </Text>
              ) : null}
              {prompt ? (
                <>
                  <TextInput
                    accessibilityLabel={prompt}
                    placeholder={prompt}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={phase.kind === "browser"}
                    value={code}
                    onChangeText={setCode}
                    className="rounded-xl px-3 py-2"
                  />
                  <Button
                    label={phase.kind === "sending" ? "Checking…" : "Continue"}
                    disabled={phase.kind === "sending" || !code.trim()}
                    onPress={() => void sendCode()}
                    tone="primary"
                    fullWidth
                  />
                </>
              ) : (
                <Text className="font-sans text-sm leading-5 text-foreground-muted">
                  Finish signing in in your browser.
                </Text>
              )}
              {verification ? (
                <Pressable
                  accessibilityRole="link"
                  hitSlop={8}
                  className="self-start active:opacity-60"
                  onPress={() => void tryOpenExternalUrl(verification.verificationUrl)}
                >
                  <Text className="font-sans text-sm text-foreground underline">Open the sign-in page again</Text>
                </Pressable>
              ) : null}
            </View>
          )}
          {error ? <Text className="font-sans text-sm leading-5 text-danger-foreground">{error}</Text> : null}
          <View className="flex-row items-center justify-between">
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              className="px-1 py-1 active:opacity-60"
              onPress={() =>
                openSettings(navigation, "SettingsEnvironmentDetail", { environmentId: EnvironmentId.make(hostId) })
              }
            >
              <Text className="font-sans text-xs text-foreground">Manage host</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: props.responding }}
              disabled={props.responding}
              hitSlop={8}
              className="px-1 py-1 active:opacity-60 disabled:opacity-50"
              onPress={() => void props.onAnswer(hostProvidersSkipAnswers())}
            >
              <Text className="font-sans text-xs text-foreground-muted">Not now</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
