import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { PillButton, type RowLine } from "../webhooks/webhook-rows";

const COPIED_FEEDBACK_MS = 1200;

/**
 * A row of the app sheet that holds its own controls: a title, the lines a
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
      {props.lines.map((line) => (
        <Text
          key={line.text}
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
