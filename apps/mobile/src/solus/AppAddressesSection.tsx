import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useListened } from "@solus-mobile/app/app-context";
import {
  appAddressesOf,
  appAddressReachLabel,
  appAddressSourceLabel,
} from "@solus-mobile/features/settings/app-addresses";
import { showsOutsideApps } from "@solus-mobile/features/settings/outside-app-setup";
import { AppText } from "../components/ui/AppText";
import { IconButton } from "../components/ui/IconButton";
import { cn } from "../lib/cn";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { solus } from "./runtime";

/**
 * Where outside apps reach this host's `/mcp` (plans/035 §0.8): each address the
 * host lists, with where it comes from (Solus account, Tailscale Funnel,
 * Tailscale Serve, or the person's own) and who can open it, and Copy. It shows to
 * each person who sees Use Solus in other apps; `HostAccessSection` loads the addresses.
 */
export function AppAddressesSection(props: { readonly hostId: string }) {
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(props.hostId));
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the "copied" timer when the section closes
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  if (access.kind !== "loaded" || !showsOutsideApps(access.info)) return null;
  const addresses = access.appEndpoint ? appAddressesOf(access.appEndpoint) : [];
  const copy = (url: string) =>
    void Clipboard.setStringAsync(url)
      .then(() => {
        clearTimeout(copiedTimer.current);
        setCopiedUrl(url);
        copiedTimer.current = setTimeout(() => setCopiedUrl(null), 2_000);
      })
      .catch(() => Alert.alert("Could not copy", url));
  return (
    <SettingsSection
      title="Addresses for apps"
      footer="Apps that run in the cloud need an address on the internet. Tailscale Serve reaches only the devices on your tailnet."
    >
      {access.appEndpointError ? (
        <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
          {access.appEndpointError}
        </AppText>
      ) : addresses.length === 0 ? (
        <AppText className="px-4 py-3 text-sm text-foreground-muted">
          This host has no address that apps can reach. Connect an app to see the ways to give it one.
        </AppText>
      ) : (
        addresses.map((address, index) => {
          const detail = `${appAddressSourceLabel(address.source)} · ${appAddressReachLabel(address.reach)}`;
          const isCopied = copiedUrl === address.url;
          return (
            <View
              key={`${address.source}:${address.url}`}
              className={cn(
                "flex-row items-center gap-3 py-3 pl-4 pr-2",
                index > 0 && "border-t border-border-subtle",
              )}
            >
              <View accessible accessibilityLabel={`${detail}, ${address.url}`} className="min-w-0 flex-1 gap-1">
                <AppText numberOfLines={1} className="text-base text-foreground">
                  {detail}
                </AppText>
                <AppText selectable numberOfLines={1} className="font-mono text-sm text-foreground-muted">
                  {address.url}
                </AppText>
              </View>
              <IconButton
                icon={isCopied ? "checkmark" : "doc.on.doc"}
                accessibilityLabel={isCopied ? "Address copied" : `Copy the ${appAddressSourceLabel(address.source)} address`}
                onPress={() => copy(address.url)}
              />
            </View>
          );
        })
      )}
    </SettingsSection>
  );
}
