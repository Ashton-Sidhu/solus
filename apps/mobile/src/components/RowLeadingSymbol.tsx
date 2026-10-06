import { Platform } from "react-native";

import { SymbolView, type AppSymbolName } from "./AppSymbol";

/**
 * A row's leading glyph as T3 Code draws it (`SettingsControlRow`): bare, no
 * tile, 22pt on iOS and 24pt on Android, in the icon ink at regular weight.
 * `muted` is for a row that cannot be chosen.
 */
export function RowLeadingSymbol(props: { readonly name: AppSymbolName; readonly muted?: boolean }) {
  return (
    <SymbolView
      name={props.name}
      size={Platform.OS === "android" ? 24 : 22}
      tintColorClassName={props.muted ? "accent-icon-subtle" : "accent-icon"}
      type="monochrome"
      weight="regular"
    />
  );
}
