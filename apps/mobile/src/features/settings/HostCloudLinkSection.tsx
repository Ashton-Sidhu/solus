import { View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { cloudLinkSummary } from "./host-cloud-link";
import { useHostCloudLink } from "./use-host-cloud-link";

/**
 * The host's Solus Cloud link, as the desktop and web Access tab shows it. A
 * phone paired with the host links and unlinks it; through the tunnel the
 * section only shows the link, and the note says where to change it.
 */
export function HostCloudLinkSection(props: { readonly hostId: string; readonly onSignIn: () => void }) {
  const app = useApp();
  const { state, link, unlink } = useHostCloudLink(props.hostId);
  const signedIn = useListened(app.account.changes, () => app.account.isSignedIn);
  if (state.kind !== "loaded" || state.control === "none") return null;
  const summary = cloudLinkSummary(state);

  return (
    <View className="gap-3">
      <SettingsSection title="Solus Cloud">
        <SettingsValueRow icon="cloud" label="Link" value={summary.value} />
        {state.control !== "manage" ? null : state.status?.linked ? (
          <SettingsActionRow
            icon="link"
            label="Unlink"
            tone="danger"
            loading={state.busy}
            disabled={state.busy}
            onPress={unlink}
          />
        ) : signedIn ? (
          <SettingsActionRow
            icon="link"
            label="Link to Solus Cloud"
            loading={state.busy}
            disabled={state.busy || !state.status}
            onPress={link}
          />
        ) : (
          <SettingsRow icon="person.crop.circle" label="Sign in to Solus Cloud" onPress={props.onSignIn} />
        )}
      </SettingsSection>
      <SettingsNote>{summary.note}</SettingsNote>
    </View>
  );
}
