import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
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
import type { Loadable } from "./use-app";

const COPIED_FEEDBACK_MS = 1200;

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
 * A row of a Manage screen that holds its own controls: a title, the lines a
 * person scans, and the buttons for that one item. A `danger` line marks what
 * needs attention.
 */
export function AppDetailRow(props: {
  readonly title: string;
  readonly trailing?: string;
  readonly trailingTone?: "muted" | "danger";
  readonly lines: readonly RowLine[];
  readonly first: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <View className={cn("gap-2 p-4", !props.first && "border-t border-border-subtle")}>
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
