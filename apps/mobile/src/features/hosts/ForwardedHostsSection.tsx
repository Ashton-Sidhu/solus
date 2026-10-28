import { ActivityIndicator, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsValueRow } from "../settings/components/SettingsValueRow";
import { forwardedHostRow } from "./forwarded-hosts";
import { useForwardedHosts } from "./use-forwarded-hosts";

/**
 * The machines this host reaches through SSH forwards it holds
 * (docs/plans/host-routes.md D7, D9), and the way to add one. Only this host
 * dials a forwarded machine; a link to the account makes it reachable from the phone.
 */
export function ForwardedHostsSection(props: {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly onAdd: () => void;
  /** Adds one of the host's WSL distros; offered on a Windows host only. */
  readonly onAddWsl: () => void;
  readonly onSignIn: () => void;
}) {
  const app = useApp();
  const { state, reload, link, remove } = useForwardedHosts(props.hostId, props.hostLabel);
  const signedIn = useListened(app.account.changes, () => app.account.isSignedIn);
  const mayReach = useListened(app.connections.changes, () => app.connections.may(props.hostId, "host.local.reach"));
  const isWindows = useListened(app.registry.changes, () => app.registry.host(props.hostId)?.os === "windows");
  if (!mayReach) return null;

  return (
    <View className="gap-3">
      <SettingsSection title="Machines over SSH">
        {state.kind === "loading" ? (
          <View className="items-center p-4">
            <ActivityIndicator accessibilityLabel="Reading machines over SSH" colorClassName="accent-icon-muted" />
          </View>
        ) : null}
        <SettingsRow
          icon="plus"
          label="Add a machine over SSH"
          accessibilityHint={`${props.hostLabel} runs SSH for this phone`}
          onPress={props.onAdd}
        />
        {isWindows ? (
          <SettingsRow
            icon="plus"
            label="Add a WSL distro"
            accessibilityHint={`${props.hostLabel} installs Solus in one of its WSL distros`}
            onPress={props.onAddWsl}
          />
        ) : null}
      </SettingsSection>
      {state.kind === "error" ? (
        <>
          <SettingsNote tone="danger">{state.message}</SettingsNote>
          <SettingsSection>
            <SettingsActionRow icon="arrow.clockwise" label="Try again" onPress={reload} />
          </SettingsSection>
        </>
      ) : state.kind === "loaded" && state.hosts.length === 0 ? (
        <SettingsNote>{`${props.hostLabel} runs SSH for this phone. A machine you link to your account is reachable from every device.`}</SettingsNote>
      ) : null}
      {state.kind === "loaded"
        ? state.hosts.map((host) => {
            const row = forwardedHostRow(host, props.hostLabel);
            const isBusy = state.busyIds.includes(host.installationId);
            return (
              <View key={host.installationId} className="gap-3">
                <SettingsSection>
                  <SettingsValueRow icon="server.rack" label={host.label} value={row.status} detail={host.sshTarget} />
                  {row.canLink ? (
                    signedIn ? (
                      <SettingsActionRow
                        icon="link"
                        label="Link to my account"
                        loading={isBusy}
                        disabled={isBusy}
                        onPress={() => link(host)}
                      />
                    ) : (
                      <SettingsRow icon="person.crop.circle" label="Sign in to link it" onPress={props.onSignIn} />
                    )
                  ) : null}
                  <SettingsActionRow
                    icon="trash"
                    label={host.isLinked ? "Remove SSH route" : "Remove"}
                    tone="danger"
                    disabled={isBusy}
                    onPress={() => remove(host)}
                  />
                </SettingsSection>
                <SettingsNote tone={row.tone === "danger" ? "danger" : "muted"}>{row.note}</SettingsNote>
              </View>
            );
          })
        : null}
    </View>
  );
}
