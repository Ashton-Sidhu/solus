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
 * Where outside apps reach this host's `/mcp` (plans/035 §0.8): **Anywhere**, the
 * address a cloud app uses, and **Your devices**, a tailnet address, each with
 * Copy. With no address the internet reaches, Anywhere offers **Set up**, which
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
          access.appEndpointError || reach.anywhere
            ? undefined
            : "Cloud apps like Claude and ChatGPT need an address on the internet."
        }
      >
        {access.appEndpointError ? (
          <AppText accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
            {access.appEndpointError}
          </AppText>
        ) : (
          <>
            {reach.anywhere ? (
              <AddressRow
                label="Anywhere"
                address={reach.anywhere}
                isCopied={copiedUrl === reach.anywhere.url}
                onCopy={copy}
              />
            ) : (
              <SetUpRow onPress={() => setIsSettingUp(true)} />
            )}
            {reach.devices ? (
              <View className="border-t border-border-subtle">
                <AddressRow
                  label="Your devices"
                  address={reach.devices}
                  isCopied={copiedUrl === reach.devices.url}
                  onCopy={copy}
                />
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
  readonly label: string;
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
        accessibilityLabel={`${props.label}, ${source}, ${address.url}`}
        className="min-w-0 flex-1 gap-0.5"
      >
        <AppText className="text-base text-foreground">{props.label}</AppText>
        <AppText selectable numberOfLines={1} ellipsizeMode="middle" className="text-sm text-foreground-muted">
          {shortAppAddress(address.url)}
        </AppText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.isCopied ? "Address copied" : `Copy the ${source} address`}
        hitSlop={8}
        onPress={() => props.onCopy(address.url)}
        className="active:opacity-70"
      >
        <AppText className="text-base text-primary-text">{props.isCopied ? "Copied" : "Copy"}</AppText>
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
