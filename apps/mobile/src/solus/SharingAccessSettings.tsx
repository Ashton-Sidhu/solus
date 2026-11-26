import { Fragment, useEffect, useState } from "react";
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
import { HostDevicesSection } from "./HostDevicesSection";
import { ApproveSignInSection, OutsideAppsSection } from "./OutsideAppsSection";
import { Note } from "./SettingsFeedback";
import { SettingsPage } from "./SettingsPages";
import { solus, useSolusWorkspace } from "./runtime";

/**
 * Settings → Sharing & access, where T3 Code's Settings puts how other apps and
 * devices reach a host. The person chooses one connected host; the page shows,
 * in order, the directory of outside apps, where apps reach the host, its
 * devices, and Approve a sign-in. It is the only page with this content: the
 * host's page links here. `environmentId` is the host whose page links here.
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
  // One read of the host's access answer, which every section below reads.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the chosen host's access answer once it is chosen
  useEffect(() => {
    if (hostId) void solus.hostAccess.load(hostId);
  }, [hostId]);
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
          <OutsideAppsSection hostId={host.id} hostName={host.label} />
          <AppAddressesSection hostId={host.id} hostName={host.label} />
          <HostDevicesSection hostId={host.id} />
          <ApproveSignInSection hostId={host.id} />
        </Fragment>
      ) : null}
    </SettingsPage>
  );
}
