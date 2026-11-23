import { View } from "react-native";
import { useGT } from "gt-react-native";
import { AppBar } from "../../components/ui/AppBar";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

export function FilesBrowserHeader(props: {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack: () => void;
}) {
  const gt = useGT();
  return (
    <AppBar
      title={gt("Files", { $context: "screen title, workspace files" })}
      subtitle={props.projectName}
      onBack={props.onBack}
      hideBottomBorder
      matchSearchSurface
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: gt("Search files"),
        closeAccessibilityLabel: gt("Close file search"),
        clearAccessibilityLabel: gt("Clear file search"),
      }}
      refresh={{ accessibilityLabel: gt("Refresh files"), onPress: props.onRefresh }}
    />
  );
}

export function FilesToolbarBottomFade() {
  const sheetColor = String(useUniwindTheme()["--color-sheet"]);

  if (process.env.EXPO_OS !== "ios") {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 bottom-0 z-[1] h-28"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="files-toolbar-bottom-fade" x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={sheetColor} stopOpacity={0} />
            <Stop offset="58%" stopColor={sheetColor} stopOpacity={0.72} />
            <Stop offset="100%" stopColor={sheetColor} stopOpacity={0.96} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#files-toolbar-bottom-fade)" />
      </Svg>
    </View>
  );
}
