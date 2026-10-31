import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import { ICON_DEFAULTS } from "@solus/client-core/icon-defaults";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName } from "./AppSymbol";

/**
 * Use SF Symbols on iOS except for pull requests, which have no matching
 * native glyph. Import only that Tabler icon to keep the bundle small.
 */
function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  if (name === "arrow.triangle.pull") {
    return (
      <IconGitPullRequest
        accessibilityLabel={props.accessibilityLabel}
        color={props.tintColor}
        size={props.size ?? ICON_DEFAULTS.size}
        strokeWidth={ICON_DEFAULTS.strokeWidth}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  return <ExpoSymbolView size={ICON_DEFAULTS.size} weight="regular" {...props} />;
}

export const SymbolView = withUniwind(AppSymbolView);
