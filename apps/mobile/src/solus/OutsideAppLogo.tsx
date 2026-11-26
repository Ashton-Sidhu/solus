import { Image, View } from "react-native";
import { SymbolView } from "../components/ui/AppSymbol";
import { outsideAppLogo } from "./outside-app-logos";

/** An app's logo in a rounded tile, as T3 Code's picker shows it; a plain tile for an app with no logo. */
export function OutsideAppLogo(props: { readonly logoId: string | null; readonly size: number }) {
  const logo = props.logoId ? outsideAppLogo(props.logoId) : null;
  const tile = { width: props.size, height: props.size, borderRadius: props.size / 4 };
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="shrink-0 items-center justify-center overflow-hidden border border-border-subtle bg-subtle"
      style={tile}
    >
      {logo ? (
        <Image source={logo} accessibilityIgnoresInvertColors style={tile} />
      ) : (
        <SymbolView name="square.grid.2x2" size={props.size / 2} tintColorClassName="accent-icon-muted" />
      )}
    </View>
  );
}
