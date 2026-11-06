import { View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { cloudLinkSummary, cloudRegistrationSummary } from "./host-cloud-link";
import { HostSelfTestSection } from "./HostSelfTestSection";
import { useHostCloudLink } from "./use-host-cloud-link";
import { hostLockMessage } from "../policy/lib/policy-view";
import { PolicyLockNote } from "../policy/PolicyLockNote";
import { useHostPolicy } from "../policy/use-host-policy";

/**
 * The host and Solus Cloud, as the desktop and web Access tab shows them
 * (docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9): "Registered to
 * your account", which a signed-in phone paired with the host makes by itself, and
 * apart from it "Reachable from the internet", the Cloudflare tunnel and nothing
 * else. Through the tunnel the section only shows them, and the notes say where to
 * change them.
 */
export function HostCloudLinkSection(props: { readonly hostId: string; readonly onSignIn: () => void }) {
  const app = useApp();
  const { state, register, setLinked } = useHostCloudLink(props.hostId);
  const signedIn = useListened(app.account.changes, () => app.account.isSignedIn);
  const cloudTunnelLock = hostLockMessage(useHostPolicy(props.hostId), "cloudTunnel");
  if (state.kind !== "loaded" || state.control === "none") return null;
  const registration = cloudRegistrationSummary(state);
  const link = cloudLinkSummary(state);
  const isRegistered = state.status?.registration.registered === true;
  const canManage = state.control === "manage";

  return (
    <View className="gap-3">
      <SettingsSection title="Solus Cloud">
        <SettingsValueRow icon="cloud" label="Registered to your account" value={registration.value} />
        {!canManage || isRegistered ? null : signedIn ? (
          <SettingsActionRow
            icon="checkmark.circle"
            label="Register"
            loading={state.busy}
            disabled={state.busy || !state.status}
            onPress={register}
          />
        ) : (
          <SettingsRow icon="person.crop.circle" label="Sign in to Solus Cloud" onPress={props.onSignIn} />
        )}
      </SettingsSection>
      <SettingsNote>{registration.note}</SettingsNote>
      {isRegistered || link.isLinked ? (
        <>
          <SettingsSection>
            <SettingsSwitchRow
              icon="globe"
              label="Reachable from the internet"
              value={link.isLinked}
              disabled={!canManage || state.busy || cloudTunnelLock !== null}
              onValueChange={setLinked}
            />
          </SettingsSection>
          {cloudTunnelLock ? <PolicyLockNote lines={[cloudTunnelLock]} /> : null}
          <SettingsNote>{link.note}</SettingsNote>
        </>
      ) : null}
      <HostSelfTestSection hostId={props.hostId} />
    </View>
  );
}
