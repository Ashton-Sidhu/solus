import { Path, Svg } from "react-native-svg";
import { View } from "react-native";

import type { FoundSource } from "@solus/contracts/integrations/found-server-labels";
import { SymbolView } from "../../../components/AppSymbol";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { cn } from "../../../lib/cn";

/** The VS Code mark of Simple Icons, in its brand blue, which holds in both themes. */
const VSCODE_PATH = "M23.15 2.587L18.21.21a1.49 1.49 0 0 0-1.705.29l-9.46 8.63l-4.12-3.128a1 1 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12L.326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a1 1 0 0 0 1.276.057l4.12-3.128l9.46 8.63a1.49 1.49 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352m-5.146 14.861L10.826 12l7.178-5.448z";

/**
 * One place a found server is in, as the logo of the tool whose config file
 * has it (docs/plans/mcp-first-class.md §8.6), as desktop and web draw it: the
 * marks of `ProviderIcon` for Claude, Codex, and Cursor, VS Code's mark, and a
 * server glyph for a port of the host. A file that turns the server off dims it.
 */
export function FoundSourceLogo(props: { readonly source: FoundSource }) {
  const { kind } = props.source;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={props.source.label} className={cn("h-3.5 w-3.5 items-center justify-center", props.source.isTurnedOff && "opacity-40")}>
      {kind === "claude-json" || kind === "mcp-json" || kind === "claude-desktop" ? (
        <ProviderIcon provider="claudeAgent" size={14} />
      ) : kind === "codex-config" ? (
        <ProviderIcon provider="codex" size={14} />
      ) : kind === "cursor" ? (
        <ProviderIcon provider="cursor" size={14} />
      ) : kind === "vscode" ? (
        <Svg width={14} height={14} viewBox="0 0 24 24" fill="none"><Path fill="#007ACC" d={VSCODE_PATH} /></Svg>
      ) : (
        <SymbolView name="server.rack" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
      )}
    </View>
  );
}
