import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { T3_CODE_BRAND_MARK_SOURCE } from "../../components/brandAssets";
import { cn } from "../../lib/cn";

/** The Solus mark, for Solus Cloud and the hosts it runs. */
export function SolusMarkIcon(props: { readonly size: number }) {
  return (
    <Image
      source={T3_CODE_BRAND_MARK_SOURCE}
      accessibilityIgnoresInvertColors
      style={{ width: props.size, height: props.size, borderRadius: props.size / 4 }}
    />
  );
}

/**
 * One way to reach a host — pair a machine, sign in to Solus Cloud — as a card
 * on the screens that ask for one (docs/plans/draft-connect-host.md). It draws
 * the desktop connect card: a hairline-bordered surface, a small icon tile,
 * and a chevron.
 */
export function ConnectOptionCard(props: {
  /** `solus-mark` draws the Solus mark, for Solus Cloud. */
  readonly icon: AppSymbolName | "solus-mark";
  readonly title: string;
  readonly detail: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.title}. ${props.detail}`}
      onPress={props.onPress}
      className={connectCardClassName}
      style={{ borderWidth: StyleSheet.hairlineWidth }}
    >
      <ConnectCardTile>
        {props.icon === "solus-mark" ? (
          <SolusMarkIcon size={18} />
        ) : (
          <SymbolView name={props.icon} size={15} tintColorClassName="accent-foreground-muted" type="monochrome" />
        )}
      </ConnectCardTile>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-t3-medium leading-snug text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-[13px] text-foreground-muted" numberOfLines={2}>
          {props.detail}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" type="monochrome" />
    </Pressable>
  );
}

/** The connect card surface, shared with the connect page's host cards. Pair it with a hairline `borderWidth`. */
export const connectCardClassName = cn(
  "flex-row items-center gap-3.5 rounded-2xl border-composer-border bg-card px-4 py-3.5 active:opacity-70",
  Platform.OS === "ios" && "shadow-[0_10px_24px_-18px] shadow-composer-shadow",
);

export function ConnectCardTile(props: { readonly children: ReactNode }) {
  return <View className="size-8 items-center justify-center rounded-[9px] bg-subtle">{props.children}</View>;
}

/** The action a host card offers (Retry, Start, Pair again), as the desktop connect page names it. */
export function ConnectCardPill(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-primary/10 px-2.5 py-0.5">
      <Text className="text-xs font-t3-medium text-primary-text">{props.label}</Text>
    </View>
  );
}
