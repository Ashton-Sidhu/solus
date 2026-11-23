import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconGitMerge from "@tabler/icons-react-native/IconGitMerge";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import type { SFSymbol } from "expo-symbols";
import IconFileDiff from "@tabler/icons-react-native/IconFileDiff";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconSitemap from "@tabler/icons-react-native/IconSitemap";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import { githubOcticons } from "./GitHubOcticons";
import type { AppSymbolViewProps } from "./AppSymbol.android";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName, AppSymbolViewProps } from "./AppSymbol.android";

const CUSTOM_ICONS = {
  ...githubOcticons,
  "file.diff": IconFileDiff,
  "arrow.triangle.merge": IconGitMerge,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.branch": IconGitBranch,
  "git.commit": IconGitCommit,
  robot: IconRobot,
  workflow: IconSitemap,
};

function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const CustomIcon = CUSTOM_ICONS[name as keyof typeof CUSTOM_ICONS];
  if (CustomIcon) {
    return (
      <CustomIcon
        accessibilityLabel={props.accessibilityLabel}
        color={props.tintColor}
        size={props.size}
        strokeWidth={2}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  return <ExpoSymbolView {...props} name={name as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
