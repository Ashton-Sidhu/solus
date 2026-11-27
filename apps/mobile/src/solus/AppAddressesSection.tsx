import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useResolveClassNames } from "uniwind";
import { useListened } from "@solus-mobile/app/app-context";
import {
  appAddressesOf,
  appAddressSourceLabel,
  appReachOf,
  shortAppAddress,
} from "@solus-mobile/features/settings/app-addresses";
import { showsOutsideApps } from "@solus-mobile/features/settings/outside-app-setup";
import type { AppAddress } from "@solus/contracts/host-api";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText } from "../components/ui/AppText";
import { RowPressable } from "../components/ui/RowPressable";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { OutsideAppConnectSheet } from "./OutsideAppConnectSheet";
import { solus } from "./runtime";

/**
 * Where outside apps reach this host's `/mcp` (plans/035 §0.8, docs/outside-apps.md):
 * one address with Copy, the internet one that cloud apps and your devices use,
 * else a tailnet one for your devices only. With no internet address, **Set up**
 * opens the ways to give the host one. It shows to each person who sees the apps.
 */
export function AppAddressesSection(props: { readonly hostId: string; readonly hostName: string }) {
  const access = useListened(solus.hostAccess.changes, () => solus.hostAccess.stateOf(props.hostId));
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the "copied" timer when the section closes
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  if (access.kind !== "loaded" || !showsOutsideApps(access.info)) return null;
  const reach = appReachOf(access.appEndpoint ? appAddressesOf(access.appEndpoint) : []);
  // One address: the internet one, which your devices use too, else the tailnet one (docs/outside-apps.md).
  const shown = reach.anywhere ?? reach.devices;
  const copy = (url: string) =>
    void Clipboard.setStringAsync(url)
      .then(() => {
        clearTimeout(copiedTimer.current);
        setCopiedUrl(url);
        copiedTimer.current = setTimeout(() => setCopiedUrl(null), 2_000);
      })
      .catch(() => Alert.alert("Could not copy", url));
  return (
    <>
      <SettingsSection
        title="Where apps reach this host"
        footer={
          access.appEndpointError
            ? undefined
            : reach.anywhere
              ? "Cloud apps like Claude and ChatGPT, and your other devices, use this address."
              : "Cloud apps like Claude and ChatGPT need an address on the internet."
        }
      >
        {access.appEndpointError ? (
          <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
            {access.appEndpointError}
          </AppText>
        ) : (
          <>
            {shown ? (
              <AddressRow
                line={
                  reach.anywhere
                    ? `Through ${appAddressSourceLabel(shown.source)}`
                    : `Your devices only, through ${appAddressSourceLabel(shown.source)}`
                }
                address={shown}
                isCopied={copiedUrl === shown.url}
                onCopy={copy}
              />
            ) : null}
            {!reach.anywhere ? (
              <View className={shown ? "border-t border-border-subtle" : undefined}>
                <SetUpRow onPress={() => setIsSettingUp(true)} />
              </View>
            ) : null}
          </>
        )}
      </SettingsSection>
      {isSettingUp ? (
        <OutsideAppConnectSheet
          hostId={props.hostId}
          hostName={props.hostName}
          guide={null}
          onClose={() => setIsSettingUp(false)}
        />
      ) : null}
    </>
  );
}

function AddressRow(props: {
  /** How the host gets the address, and who it reaches when that is not everyone. */
  readonly line: string;
  readonly address: AppAddress;
  readonly isCopied: boolean;
  readonly onCopy: (url: string) => void;
}) {
  const { address } = props;
  const source = appAddressSourceLabel(address.source);
  return (
    <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
      <View
        accessible
        accessibilityLabel={`${address.url}, ${props.line}`}
        className="min-w-0 flex-1 gap-0.5"
      >
        <AppText selectable numberOfLines={1} ellipsizeMode="middle" className="text-base text-foreground">
          {shortAppAddress(address.url)}
        </AppText>
        <AppText className="text-sm text-foreground-muted">{props.line}</AppText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.isCopied ? "Address copied" : `Copy the ${source} address`}
        hitSlop={8}
        onPress={() => props.onCopy(address.url)}
        className="active:opacity-70"
      >
        <AppText className="text-base text-foreground-secondary">{props.isCopied ? "Copied" : "Copy"}</AppText>
      </Pressable>
    </View>
  );
}

function SetUpRow(props: { readonly onPress: () => void }) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel="Anywhere, for cloud apps, set up"
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <AppText className="text-base text-foreground">Anywhere</AppText>
          <AppText className="text-sm text-foreground-muted">For cloud apps</AppText>
        </View>
        <AppText className="text-base text-primary-text">Set up</AppText>
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </View>
    </RowPressable>
  );
}
