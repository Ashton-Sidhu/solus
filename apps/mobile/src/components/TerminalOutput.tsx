import { ScrollView, Text, View, type TextStyle } from "react-native";
import { terminalLines, type TerminalColor, type TerminalSpan } from "@solus/client-core/terminal-text";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import type { MobileThemeVariable } from "../lib/mobileTheme";

/** Each colour's variable, plain then bright. */
const ANSI_VARIABLES = {
  black: ["--color-terminal-ansi-black", "--color-terminal-ansi-bright-black"],
  red: ["--color-terminal-ansi-red", "--color-terminal-ansi-bright-red"],
  green: ["--color-terminal-ansi-green", "--color-terminal-ansi-bright-green"],
  yellow: ["--color-terminal-ansi-yellow", "--color-terminal-ansi-bright-yellow"],
  blue: ["--color-terminal-ansi-blue", "--color-terminal-ansi-bright-blue"],
  magenta: ["--color-terminal-ansi-magenta", "--color-terminal-ansi-bright-magenta"],
  cyan: ["--color-terminal-ansi-cyan", "--color-terminal-ansi-bright-cyan"],
  white: ["--color-terminal-ansi-white", "--color-terminal-ansi-bright-white"],
} satisfies Record<TerminalColor, readonly [MobileThemeVariable, MobileThemeVariable]>;

/**
 * A command's output as the terminal showed it, as desktop draws it
 * (`ui/terminal-output`): the theme's terminal panel, mono, every line as
 * printed, the colours the tool chose, and an error or warning line in its
 * tone when the tool printed no colour of its own. The colours are the
 * `--color-terminal-*` variables, so they follow the appearance.
 */
export function TerminalOutput({
  output,
  label,
  maxHeight = 320,
}: {
  readonly output: string;
  readonly label: string;
  readonly maxHeight?: number;
}) {
  const theme = useUniwindTheme();
  const lines = terminalLines(output);
  const spanStyle = (span: TerminalSpan): TextStyle | undefined => {
    const color = span.color ? theme[ANSI_VARIABLES[span.color][span.bright ? 1 : 0]] : undefined;
    if (!color && !span.bold && !span.dim) return undefined;
    return { color, fontWeight: span.bold ? "600" : undefined, opacity: span.dim ? 0.7 : undefined };
  };
  return (
    <View
      accessibilityLabel={label}
      className="rounded-lg px-3 py-2.5"
      style={{
        maxHeight,
        backgroundColor: theme["--color-terminal-background"],
        borderWidth: 0.5,
        borderColor: theme["--color-terminal-border"],
      }}
    >
      <ScrollView nestedScrollEnabled directionalLockEnabled showsVerticalScrollIndicator>
        <Text selectable className="font-mono text-2xs leading-normal" style={{ color: theme["--color-terminal-foreground"] }}>
          {lines.map((line, index) => {
            const lineColor =
              line.tone === "error"
                ? theme["--color-terminal-error"]
                : line.tone === "warning"
                  ? theme["--color-terminal-warning"]
                  : undefined;
            return (
              <Text key={index} style={lineColor ? { color: lineColor } : undefined}>
                {line.spans.map((span, spanIndex) => (
                  <Text key={spanIndex} style={spanStyle(span)}>
                    {span.text}
                  </Text>
                ))}
                {index < lines.length - 1 ? "\n" : ""}
              </Text>
            );
          })}
        </Text>
      </ScrollView>
    </View>
  );
}
