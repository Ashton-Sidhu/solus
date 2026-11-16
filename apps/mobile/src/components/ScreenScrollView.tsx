import { createContext, use, type ComponentProps } from "react";
import { cn } from "../lib/cn";
import { Platform } from "react-native";
import { NativeScrollView as ScrollView } from "../native/NativeScrollViewMarker";

export const ScreenScrollViewSurface = createContext<string | undefined>(undefined);

/** Keeps forms and settings readable inside a wide pane while its surface fills the screen. */
export function ScreenScrollView(props: ComponentProps<typeof ScrollView>) {
  const surface = use(ScreenScrollViewSurface);
  return (
    <ScrollView
      {...props}
      className={Platform.OS === "ios" && surface ? cn(surface, props.className) : props.className}
      contentContainerStyle={[
        props.contentContainerStyle,
        Platform.OS === "android" && {
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        },
      ]}
    />
  );
}
