import { useMemo } from "react";
import { View } from "react-native";
import { Path, Svg } from "react-native-svg";

import { encodeQrByteMode } from "@solus/client-core/qr";

/** The pairing link as a QR code another device scans. Dark modules on white in
 *  both themes: a scanner needs the contrast, and a quiet zone of four modules. */
export function PairQrCode(props: { readonly value: string; readonly size?: number }) {
  const qr = useMemo(() => {
    const matrix = encodeQrByteMode(props.value);
    let path = "";
    matrix.modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`;
      });
    });
    return { path, viewBox: `0 0 ${matrix.size + 8} ${matrix.size + 8}` };
  }, [props.value]);
  const size = props.size ?? 200;

  return (
    <View accessible accessibilityLabel="Pairing QR code" className="self-center overflow-hidden rounded-lg bg-white">
      <Svg width={size} height={size} viewBox={qr.viewBox}>
        <Path d={qr.path} fill="#000" />
      </Svg>
    </View>
  );
}
