import { Fragment, useState } from "react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  sharingAccessHost,
  sharingAccessHosts,
} from "@solus-mobile/features/settings/sharing-access";
import { ListChoiceRow } from "../components/ui/ListChoiceRow";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { useSolusSettingsFilter } from "../features/settings/settings-environment-filter";
import { AppAddressesSection } from "./AppAddressesSection";
import { HostAccessSection } from "./HostAccessSection";
import { OutsideAppsSection } from "./OutsideAppsSection";
import { Note } from "./SettingsFeedback";
import { SettingsPage } from "./SettingsPages";
import { useSolusWorkspace } from "./runtime";

/**
 * Settings → Sharing & access, where T3 Code's Settings puts how other apps and
 * devices reach a host. The person chooses one connected host; the page shows
 * its pairing code and approval requests, Use Solus in other apps, and Connected
 * apps, with the same sections as the host's page, and the addresses at which
 * apps reach the host. `environmentId` is the host
 * whose page links here.
 */
export function SharingAccessSettings({
  route,
}: StaticScreenProps<{ environmentId?: EnvironmentId } | undefined>) {
  const { environments } = useSolusWorkspace();
  const { selectedIds } = useSolusSettingsFilter();
  const [chosen, setChosen] = useState<string | null>(null);
  const hosts = sharingAccessHosts(environments);
  const hostId = sharingAccessHost(hosts, {
    chosen,
    linked: route.params?.environmentId ?? null,
    scoped: selectedIds?.size === 1 ? [...selectedIds][0]! : null,
  });
  const host = hosts.find((entry) => entry.id === hostId);
  return (
    <SettingsPage title="Sharing & access">
      <SettingsSection title="Host">
        {hosts.length === 0 ? (
          <Note>Connect to a host to share it.</Note>
        ) : (
          hosts.map((entry, index) => (
            <ListChoiceRow
              key={entry.id}
              label={entry.label}
              separated={index > 0}
              selected={entry.id === hostId}
              onPress={() => setChosen(entry.id)}
            />
          ))
        )}
      </SettingsSection>
      {host ? (
        // A new host gets new sections, so a sheet of the last host does not stay open.
        <Fragment key={host.id}>
          {/* It also loads the host's access answer, which Use Solus in other apps reads. */}
          <HostAccessSection hostId={host.id} isConnected makeCode={false} />
          <OutsideAppsSection hostId={host.id} hostName={host.label} />
          <AppAddressesSection hostId={host.id} />
        </Fragment>
      ) : null}
    </SettingsPage>
  );
}
