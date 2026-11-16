import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { RowPressable } from "../../components/RowPressable";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { HostStatusBanner } from "../hosts/HostStatusBanner";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ChoiceChip, PillButton, type RowLine } from "../webhooks/webhook-rows";
import type { AppState } from "@solus/contracts/apps";

import type { FilterChoice } from "./app-activity";
import type { AppItemState, AppRowMark } from "./app-states";
import type { Loadable } from "./use-app";

const COPIED_FEEDBACK_MS = 1200;

/**
 * The symbol of each state, in the state's colour. Android has no glyph for a
 * dashed circle, a pause, or a slashed circle, so `running` is the clock that
 * the pull request checks use, and the two others take the nearest glyph.
 */
const STATE_SYMBOLS = {
  ok: { name: "checkmark.circle", tint: "accent-adaptive-emerald-600-400" },
  failed: { name: "xmark.circle.fill", tint: "accent-danger-foreground" },
  running: { name: "clock", tint: "accent-adaptive-sky-600-400" },
  sleeping: { name: "moon", tint: "accent-icon-muted" },
  paused: { name: { ios: "pause.circle", android: "remove" }, tint: "accent-icon-muted" },
  stopped: { name: { ios: "slash.circle", android: "close" }, tint: "accent-icon-muted" },
  idle: { name: "circle", tint: "accent-icon-subtle" },
  warning: { name: "exclamationmark.triangle", tint: "accent-warning-foreground" },
} as const satisfies { [State in AppItemState]: { name: AppSymbolName; tint: string } };

/**
 * The one mark for how a thing of the Manage screens stands: a call, a run, a
 * step, a version, a delivery, a schedule. The shape says the state, so the
 * colour is not the only signal.
 */
export function AppStateMark(props: { readonly mark: AppRowMark; readonly size?: number }) {
  const symbol = STATE_SYMBOLS[props.mark.state];
  const { label } = props.mark;
  return (
    <View accessible={label !== undefined} accessibilityRole="image" accessibilityLabel={label}>
      <SymbolView name={symbol.name} size={props.size ?? 18} tintColorClassName={symbol.tint} type="monochrome" weight="regular" />
    </View>
  );
}

/**
 * The frame of one Manage screen: its header, the state of the host when it
 * is not ready, and its content in one scroll view. A field in the content
 * stays above the keyboard.
 */
export function AppPage(props: { readonly title: string; readonly hostId: string; readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title}>
      <HostStatusBanner hostId={props.hostId} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

/**
 * The app of a Manage screen, or why it does not show: it was deleted, its
 * host is not connected, the read failed, or the read is in progress. An app
 * that was read stays on screen when its host is not connected, under a line
 * that says so.
 */
export function AppStateBody(props: {
  readonly state: Loadable<AppState>;
  readonly connected: boolean;
  readonly isDeleted: boolean;
  readonly onRetry: () => void;
  readonly children: (state: AppState) => ReactNode;
}) {
  const { state } = props;
  if (props.isDeleted) return <SettingsNote>This app no longer exists.</SettingsNote>;
  if (state.kind === "loaded") {
    return (
      <>
        {!props.connected ? (
          <SettingsNote>This host is not connected. What shows here can be old, and nothing can be changed.</SettingsNote>
        ) : null}
        {props.children(state.value)}
      </>
    );
  }
  if (!props.connected) return <SettingsNote>Connect this host to manage this app.</SettingsNote>;
  if (state.kind === "error") {
    return (
      <View className="gap-3">
        <ErrorBanner message={`The app could not be read: ${state.message}`} />
        <PillButton label="Try again" onPress={props.onRetry} />
      </View>
    );
  }
  return (
    <View className="items-center py-2">
      <ActivityIndicator accessibilityLabel="Reading the app" colorClassName="accent-icon-muted" />
    </View>
  );
}

/**
 * One read of a Manage screen: its value, or why there is none. `subject`
 * names what is read, as the start of a sentence: "The call log". A value
 * that was read stays on screen when the host is not connected; the screen
 * says once that it can be old.
 */
export function ReadBody<T>(props: {
  readonly read: Loadable<T>;
  readonly connected: boolean;
  readonly subject: string;
  readonly onRetry: () => void;
  readonly children: (value: T) => ReactNode;
}) {
  const { read } = props;
  if (read.kind === "loaded") return props.children(read.value);
  if (!props.connected) return <SettingsNote>{`${props.subject} shows when this host is connected.`}</SettingsNote>;
  if (read.kind === "error") {
    return (
      <View className="gap-3">
        <ErrorBanner message={`${props.subject} could not be read: ${read.message}`} />
        <PillButton label="Try again" onPress={props.onRetry} />
      </View>
    );
  }
  return (
    <View className="items-center py-2">
      <ActivityIndicator accessibilityLabel={`Reading: ${props.subject}`} colorClassName="accent-icon-muted" />
    </View>
  );
}

/** One list of a Manage screen in a titled group: its rows, or why there are none. */
export function LoadedSection<T>(props: {
  readonly title: string;
  readonly read: Loadable<readonly T[]>;
  readonly connected: boolean;
  /** What is read, as the start of a sentence: "The schedules". */
  readonly subject: string;
  readonly empty: string;
  /** A quiet line under the rows. */
  readonly note?: string;
  readonly onRetry: () => void;
  readonly children: (items: readonly T[]) => ReactNode;
}) {
  return (
    <ReadBody read={props.read} connected={props.connected} subject={props.subject} onRetry={props.onRetry}>
      {(items) => (
        <View className="gap-3">
          <SettingsSection title={props.title}>
            {items.length === 0 ? (
              <View className="px-2 py-4">
                <SettingsNote>{props.empty}</SettingsNote>
              </View>
            ) : (
              props.children(items)
            )}
          </SettingsSection>
          {props.note ? <SettingsNote>{props.note}</SettingsNote> : null}
        </View>
      )}
    </ReadBody>
  );
}

/** The choices of one filter, in one row that scrolls sideways. `label` names the filter for a screen reader. */
export function FilterChips<Value extends string>(props: {
  readonly label: string;
  readonly choices: readonly FilterChoice<Value>[];
  readonly selected: Value | null;
  readonly onSelect: (value: Value | null) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={props.label}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-2"
    >
      {props.choices.map((choice) => (
        <ChoiceChip
          key={choice.value ?? ""}
          role="button"
          label={choice.label}
          selected={choice.value === props.selected}
          onPress={() => props.onSelect(choice.value)}
        />
      ))}
    </ScrollView>
  );
}

/** Text a program wrote, as it wrote it: an input, a schema, a log, a stack. The person can select it. */
export function MonoBlock(props: { readonly text: string; readonly tone?: "danger"; readonly maxLines?: number }) {
  return (
    <View className="rounded-xl bg-subtle px-3 py-2">
      <Text
        selectable
        numberOfLines={props.maxLines}
        className={cn("font-mono text-xs", props.tone === "danger" ? "text-danger-foreground" : "text-foreground")}
      >
        {props.text}
      </Text>
    </View>
  );
}

/**
 * A row that opens a call, a run, or a section: the mark of its state, a
 * title, a fact at its end (an age), and the lines a person scans. The words
 * of the state are in the lines or in the label of the mark, never in a badge.
 */
export function AppListRow(props: {
  readonly mark?: AppRowMark;
  readonly title: string;
  /** A fact of the item, such as its age. The state is the mark. */
  readonly trailing?: string;
  readonly lines: readonly RowLine[];
  readonly first: boolean;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.title, props.mark?.label, props.trailing, ...props.lines.map((line) => line.text)].filter(Boolean).join(", ")}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={cn("bg-grouped-card", !props.first && "border-t border-border-subtle")}
    >
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        {props.mark ? (
          <View className="size-6 items-center justify-center self-start">
            <AppStateMark mark={props.mark} />
          </View>
        ) : null}
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
            {props.trailing ? <Text className="shrink-0 text-sm text-foreground-muted">{props.trailing}</Text> : null}
          </View>
          {props.lines.map((line, index) => (
            <Text
              // Two lines of one row can say the same.
              key={`${index}:${line.text}`}
              className={cn("text-sm", line.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")}
            >
              {line.text}
            </Text>
          ))}
        </View>
        <SymbolView name="chevron.right" size={16} tintColorClassName="accent-chevron" type="monochrome" weight="semibold" />
      </View>
    </RowPressable>
  );
}

/**
 * A row of a Manage screen that holds its own controls: the mark of its
 * state, a title, the lines a person scans, and the buttons for that one
 * item. A `danger` line marks what needs attention.
 */
export function AppDetailRow(props: {
  readonly mark?: AppRowMark;
  readonly title: string;
  /** How many lines the title takes before it is cut. One when absent. */
  readonly titleLines?: number;
  /** A fact of the item, such as its size or its time. The state is the mark. */
  readonly trailing?: string;
  readonly trailingTone?: "muted" | "danger";
  readonly lines: readonly RowLine[];
  readonly first: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <View className={cn("flex-row gap-3 p-4", !props.first && "border-t border-border-subtle")}>
      {props.mark ? (
        <View className="size-6 items-center justify-center">
          <AppStateMark mark={props.mark} />
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-2">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={props.titleLines ?? 1}>
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
        {props.lines.map((line, index) => (
          <Text
            // Two lines of one row can say the same: two actions that ended the same way.
            key={`${index}:${line.text}`}
            selectable={line.tone === "danger"}
            className={cn("text-sm", line.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")}
          >
            {line.text}
          </Text>
        ))}
        {props.children ? <View className="flex-row flex-wrap gap-2 pt-1">{props.children}</View> : null}
      </View>
    </View>
  );
}

/** Puts one value on the clipboard and says so for a moment. `target` names the value in words. */
export function CopyPill(props: { readonly label: string; readonly target: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = () => {
    void tryCopyTextWithHaptic(props.value, { target: props.target }).then((done) => {
      if (!done) {
        Alert.alert("Not copied", "The clipboard refused the value. Try again.");
        return;
      }
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  };

  return <PillButton label={copied ? "Copied" : props.label} onPress={copy} />;
}
