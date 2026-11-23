import { useLinearConnection, linearConnectionValue } from "./use-linear-connection";
import { Note, useSettingsAction } from "./SettingsFeedback";
import { useState } from "react";
import { Alert, Linking } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HostApi } from "@solus/client-core/host-api";
import { useListened } from "@solus-mobile/app/app-context";
import { AppTextInput } from "../components/ui/AppText";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { useSettingsEnvironmentMenu } from "../features/settings/components/SettingsEnvironmentFilterHeader";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import { SettingsPage } from "./SettingsPages";
import { solus } from "./runtime";
import { useGithubConnection } from "./use-github-connection";
import { useHostSettingsRead } from "./use-host-settings-read";

export function SourceControlSettings() {
  const menu = useSettingsEnvironmentMenu();
  const { scopedTargets } = useSolusSettingsFilter();
  const nav = useNavigation();
  return (
    <SettingsPage title="Source control & issues" menus={[menu]}>
      {!scopedTargets.length && <Note>Select a connected environment.</Note>}
      {scopedTargets.map((h) => (
        <SettingsSection key={h.environmentId} title={h.environmentLabel}>
          <SettingsRow
            icon="arrow.triangle.branch"
            label="GitHub"
            onPress={() =>
              nav.navigate("SettingsSourceControlProvider", {
                environmentId: h.environmentId,
                kind: "github",
              })
            }
          />
          <SettingsRow
            icon="link"
            label="Jira"
            onPress={() =>
              nav.navigate("SettingsIssueTracker", {
                environmentId: h.environmentId,
                tracker: "jira",
              })
            }
          />
          <SettingsRow
            icon="link"
            label="Linear"
            onPress={() =>
              nav.navigate("SettingsIssueTracker", {
                environmentId: h.environmentId,
                tracker: "linear",
              })
            }
          />
        </SettingsSection>
      ))}
    </SettingsPage>
  );
}
export function GithubSettings({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId; kind: string }>) {
  const { view, refresh, connect, cancel, disconnect } = useGithubConnection(
    route.params.environmentId,
  );
  const { run, busy } = useSettingsAction(refresh);
  const admin = solus.connections.may(route.params.environmentId, "host.admin.connections");
  return (
    <SettingsPage title="GitHub">
      <SettingsSection title="Connection">
        {view.kind === "account" ? (
          <>
            <Note>
              {view.status?.kind === "connected"
                ? (view.status.label ?? "Connected")
                : view.status?.kind === "failed"
                  ? view.status.message
                  : "Manage GitHub through your Solus account."}
            </Note>
            <SettingsRow
              icon="person.crop.circle"
              label="Manage account connection"
              onPress={() => void run(() => Linking.openURL(view.url))}
            />
          </>
        ) : view.kind === "connecting" ? (
          <>
            {view.prompt ? (
              <SettingsRow
                icon="link"
                label="Open GitHub and enter this code"
                value={view.prompt.userCode}
                onPress={() => void run(() => Linking.openURL(view.prompt!.verificationUri))}
              />
            ) : (
              <Note>Waiting for GitHub…</Note>
            )}
            <SettingsRow icon="xmark" label="Cancel sign-in" onPress={cancel} />
          </>
        ) : view.kind === "loading" ? (
          <Note>Checking connection…</Note>
        ) : view.kind === "error" ? (
          <>
            <Note>{view.message}</Note>
            <SettingsRow icon="arrow.clockwise" label="Try again" onPress={refresh} />
          </>
        ) : (
          <SettingsRow
            icon="person.crop.circle"
            label={view.kind === "connected" ? "Disconnect GitHub" : "Connect GitHub"}
            value={view.kind === "connected" ? (view.login ?? "Connected") : undefined}
            disabled={!admin || busy}
            onPress={() =>
              view.kind === "connected"
                ? Alert.alert("Disconnect GitHub?", undefined, [
                    { text: "Cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => void run(disconnect),
                    },
                  ])
                : void connect()
            }
          />
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
const loadJira = async (api: HostApi) => {
  const [status, info] = await Promise.all([
    api.atlassianStatus(),
    api.connectionsGetServerInfo().catch(() => null),
  ]);
  return { ...status, accountConnectionsUrl: info?.accountConnectionsUrl };
};
export function IssueTrackerSettings(
  props: StaticScreenProps<{ environmentId: EnvironmentId; tracker: string }>,
) {
  if (props.route.params.tracker === "linear")
    return <LinearSettings hostId={props.route.params.environmentId} />;
  return <JiraSettings {...props} />;
}
function LinearSettings({ hostId }: { hostId: string }) {
  const { state, store } = useLinearConnection(hostId);
  const [key, setKey] = useState("");
  const admin = useListened(solus.connections.changes, () =>
    solus.connections.may(hostId, "host.admin.connections"),
  );
  const canManage = state.location === "account" || (state.location === "host" && admin);
  return (
    <SettingsPage title="Linear">
      <SettingsSection title="Connection">
        <Note>{state.error ?? linearConnectionValue(state)}</Note>
        {canManage && (
          <>
            <AppTextInput
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Linear API key"
              placeholder="Personal API key"
              className="mx-4 my-3 min-h-10 rounded-xl px-3 py-2"
              value={key}
              onChangeText={setKey}
            />
            <SettingsRow
              icon="link"
              label={state.connected ? "Replace API key" : "Connect Linear"}
              disabled={state.pending || !key.trim()}
              onPress={() => {
                const input = key.trim();
                setKey("");
                void store.save(input);
              }}
            />
            {state.connected && (
              <SettingsRow
                icon="xmark"
                label="Disconnect Linear"
                disabled={state.pending}
                onPress={() =>
                  Alert.alert("Disconnect Linear?", undefined, [
                    { text: "Cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => void store.disconnect(),
                    },
                  ])
                }
              />
            )}
          </>
        )}
        <SettingsRow icon="arrow.clockwise" label="Refresh" onPress={() => void store.load()} />
      </SettingsSection>
    </SettingsPage>
  );
}
function JiraSettings({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId; tracker: string }>) {
  const id = route.params.environmentId;
  const state = useHostSettingsRead(id, loadJira, "atlassian.oauthCompleted");
  const { run, busy } = useSettingsAction(state.refresh);
  const admin = solus.connections.may(id, "host.admin.connections");
  const jira = state.data;
  const [site, setSite] = useState(""),
    [email, setEmail] = useState(""),
    [token, setToken] = useState("");
  return (
    <SettingsPage title="Jira">
      <SettingsSection title="Connection">
        {!jira ? (
          <Note>{state.error ?? "Checking connection…"}</Note>
        ) : (
          <>
            <Note>
              {jira.connected ? (jira.siteName ?? jira.siteUrl ?? "Connected") : "Disconnected"}
            </Note>
            {jira.accountConnectionsUrl ? (
              <SettingsRow
                icon="person.crop.circle"
                label="Manage account connection"
                onPress={() => void run(() => Linking.openURL(jira.accountConnectionsUrl!))}
              />
            ) : jira.connected ? (
              <SettingsRow
                icon="xmark"
                label="Disconnect Jira"
                disabled={busy || !admin}
                onPress={() =>
                  Alert.alert("Disconnect Jira?", undefined, [
                    { text: "Cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => void run(() => state.api!.atlassianDisconnect()),
                    },
                  ])
                }
              />
            ) : (
              jira.oauthAvailable && (
                <SettingsRow
                  icon="link"
                  label="Connect Jira"
                  disabled={!admin || busy}
                  onPress={() =>
                    void run(async () => {
                      const flow = await state.api!.atlassianStartOAuth();
                      if (!flow.ok) throw new Error(flow.error);
                      await Linking.openURL(flow.authUrl);
                    })
                  }
                />
              )
            )}
            {jira.apiTokenAvailable && !jira.connected && admin && !jira.accountConnectionsUrl && (
              <>
                <AppTextInput
                  value={site}
                  onChangeText={setSite}
                  accessibilityLabel="Jira site"
                  placeholder="Site address"
                  autoCapitalize="none"
                  keyboardType="url"
                  className="mx-4 my-3 min-h-10 rounded-xl px-3 py-2"
                />
                <AppTextInput
                  value={email}
                  onChangeText={setEmail}
                  accessibilityLabel="Atlassian email"
                  placeholder="Email"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  className="mx-4 mb-3 min-h-10 rounded-xl px-3 py-2"
                />
                <AppTextInput
                  value={token}
                  onChangeText={setToken}
                  accessibilityLabel="Atlassian API token"
                  placeholder="API token"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="mx-4 mb-3 min-h-10 rounded-xl px-3 py-2"
                />
                <SettingsRow
                  label="Connect with API token"
                  icon="link"
                  disabled={busy || !site.trim() || !email.trim() || !token.trim()}
                  onPress={() =>
                    void run(async () => {
                      const result = await state.api!.atlassianConnectApiToken({
                        siteUrl: site.trim(),
                        email: email.trim(),
                        apiToken: token.trim(),
                      });
                      if (!result.ok) throw new Error(result.error);
                      setToken("");
                    })
                  }
                />
              </>
            )}
          </>
        )}
        <SettingsRow icon="arrow.clockwise" label="Refresh" onPress={state.refresh} />
      </SettingsSection>
    </SettingsPage>
  );
}
