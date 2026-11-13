import { Platform, Pressable, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";

export interface RowLine {
  readonly text: string;
  readonly tone?: "muted" | "danger";
}

/**
 * A row that opens a webhook, a delivery, or an app: a title and the lines a
 * person scans in a list. A `danger` line marks what needs attention.
 */
export function WebhookListRow(props: {
  readonly title: string;
  readonly trailing?: string;
  readonly trailingTone?: "muted" | "danger";
  readonly lines: readonly RowLine[];
  readonly first: boolean;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.title, props.trailing, ...props.lines.map((line) => line.text)].filter(Boolean).join(", ")}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={cn("bg-grouped-card", !props.first && "border-t border-border-subtle")}
    >
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
            {props.trailing ? (
              <Text
                className={cn(
                  "shrink-0 text-sm",
                  props.trailingTone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
                )}
              >
                {props.trailing}
              </Text>
            ) : null}
          </View>
          {props.lines.map((line) => (
            <Text
              key={line.text}
              className={cn("text-sm", line.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")}
            >
              {line.text}
            </Text>
          ))}
        </View>
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

/** A small secondary button, as the other settings screens draw Try again. */
export function PillButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn("self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70", props.disabled && "opacity-40")}
    >
      <Text className="text-xs font-t3-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/** A choice among a few, as Solus Cloud draws the organization choice. */
export function ChoiceChip(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly role: "tab" | "button";
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.role}
      accessibilityState={{ selected: props.selected }}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
      className={cn("rounded-full px-3.5 py-2 active:opacity-70", props.selected ? "bg-primary" : "bg-subtle")}
    >
      <Text className={cn("text-xs font-t3-bold", props.selected ? "text-primary-foreground" : "text-foreground")}>
        {props.label}
      </Text>
    </Pressable>
  );
}
