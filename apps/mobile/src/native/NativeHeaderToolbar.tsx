// Adapted from T3 Code apps/mobile/src/native/NativeHeaderToolbar.tsx (MIT, see UPSTREAM.md): only the v5 tab guard, in-place updates, image icons, and the prominent button variant are taken from its newer copy.
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import {
  Children,
  isValidElement,
  use,
  useLayoutEffect,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorValue, ImageSourcePropType } from "react-native";
import { NativeWorkspaceTabActivityContext } from "./v5-workspace-context";

function useNativeStackNavigation(): NativeStackNavigationProp<ParamListBase> | null {
  return useNavigation<NativeStackNavigationProp<ParamListBase>>();
}

function labelFromChildren(children: ReactNode): string {
  const parts: string[] = [];
  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      parts.push(String(child));
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      parts.push(labelFromChildren(child.props.children));
    }
  });
  return parts.join("");
}

type NativeStackHeaderIcon = NonNullable<
  Extract<NativeStackHeaderItem, { type: "button" }>["icon"]
>;
type NativeStackOptionsWithToolbar = NativeStackNavigationOptions & {
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

/** A toolbar icon: an SF Symbol name, or a template image for a glyph SF Symbols lacks. */
export type NativeHeaderToolbarIcon = string | { readonly type: "image"; readonly source: ImageSourcePropType };

function iconFromProp(icon: unknown): NativeStackHeaderIcon | undefined {
  if (typeof icon === "string") {
    return { type: "sfSymbol", name: icon as never };
  }
  if (typeof icon === "object" && icon !== null && (icon as { type?: unknown }).type === "image") {
    return icon as NativeStackHeaderIcon;
  }
  return undefined;
}

type ToolbarElementProps = Record<string, unknown> & { readonly children?: ReactNode };

function elementTypeName(element: ReactElement): string | undefined {
  const type = element.type;
  if (typeof type === "function") {
    return (type as { displayName?: string; name?: string }).displayName ?? type.name;
  }
  return undefined;
}

function convertMenuAction(
  element: ReactElement<ToolbarElementProps>,
): NativeStackHeaderItemMenu["menu"]["items"][number] | null {
  const typeName = elementTypeName(element);
  if (typeName === "NativeHeaderToolbarMenuAction") {
    const label = labelFromChildren(element.props.children);
    return {
      type: "action",
      label,
      description: typeof element.props.subtitle === "string" ? element.props.subtitle : undefined,
      disabled: Boolean(element.props.disabled),
      icon: iconFromProp(element.props.icon),
      onPress:
        typeof element.props.onPress === "function"
          ? (element.props.onPress as () => void)
          : () => undefined,
      state: element.props.isOn === true ? "on" : undefined,
      destructive: Boolean(element.props.destructive),
      discoverabilityLabel:
        typeof element.props.discoverabilityLabel === "string"
          ? element.props.discoverabilityLabel
          : undefined,
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "submenu",
      label:
        typeof element.props.title === "string"
          ? element.props.title
          : labelFromChildren(element.props.children),
      icon: iconFromProp(element.props.icon),
      inline: Boolean(element.props.inline),
      items: collectMenuItems(element.props.children),
    };
  }

  return null;
}

function collectMenuItems(children: ReactNode): NativeStackHeaderItemMenu["menu"]["items"] {
  const items: NativeStackHeaderItemMenu["menu"]["items"] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ToolbarElementProps>(child)) {
      return;
    }
    const item = convertMenuAction(child);
    if (item) {
      items.push(item);
      return;
    }
    items.push(...collectMenuItems(child.props.children));
  });
  return items;
}

function convertToolbarChild(child: ReactNode): NativeStackHeaderItem | null {
  if (!isValidElement<ToolbarElementProps>(child)) {
    return null;
  }

  const typeName = elementTypeName(child);
  if (typeName === "NativeHeaderToolbarButton") {
    return {
      type: "button",
      label: typeof child.props.label === "string" ? child.props.label : "",
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      onPress:
        typeof child.props.onPress === "function"
          ? (child.props.onPress as () => void)
          : () => undefined,
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: child.props.variant === "prominent" ? "prominent" : "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "menu",
      label: typeof child.props.title === "string" ? child.props.title : "",
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      menu: {
        title: typeof child.props.title === "string" ? child.props.title : undefined,
        items: collectMenuItems(child.props.children),
      },
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarSpacer") {
    return {
      type: "spacing",
      spacing: typeof child.props.width === "number" ? child.props.width : 8,
      flexible: Boolean(child.props.flexible),
    } as NativeStackHeaderItem;
  }

  return null;
}

function collectToolbarItems(children: ReactNode): NativeStackHeaderItem[] {
  const items: NativeStackHeaderItem[] = [];
  Children.forEach(children, (child) => {
    const item = convertToolbarChild(child);
    if (item) {
      if (item.type === "spacing") {
        // Native inserts spacing items at `index`, treating a missing index
        // as 0 — which would move the spacer in front of earlier siblings.
        (item as { index?: number }).index = items.length;
      }
      items.push(item);
    }
  });
  return items;
}

function NativeHeaderToolbarRoot(props: {
  readonly placement?: "left" | "right" | "bottom";
  readonly children?: ReactNode;
}) {
  const navigation = useNativeStackNavigation();
  // A retained iOS tab must not set the header of the tab shown (T3 Code's v5 shell).
  const tabActivity = use(NativeWorkspaceTabActivityContext);
  const tabActive = tabActivity?.active ?? true;
  const isTabActive = tabActivity?.isActive;
  const items = useMemo(() => collectToolbarItems(props.children), [props.children]);

  // Update items in place. Clearing them on every render causes UIKit to run a
  // second transition and detach custom views while the stack is animating.
  useLayoutEffect(() => {
    if (!navigation || !tabActive) {
      return;
    }
    if (props.placement === "bottom") {
      navigation.setOptions({
        unstable_headerToolbarItems: () => items,
      } as NativeStackOptionsWithToolbar);
      return;
    }
    if (props.placement === "left") {
      navigation.setOptions({ unstable_headerLeftItems: () => items });
      return;
    }
    navigation.setOptions({ unstable_headerRightItems: () => items });
  }, [items, navigation, props.placement, tabActive]);

  useLayoutEffect(() => {
    if (!navigation) return;
    return () => {
      if (isTabActive && !isTabActive()) return;
      if (props.placement === "bottom") {
        navigation.setOptions({
          unstable_headerToolbarItems: () => [],
        } as NativeStackOptionsWithToolbar);
      } else if (props.placement === "left") {
        navigation.setOptions({ unstable_headerLeftItems: () => [] });
      } else {
        navigation.setOptions({ unstable_headerRightItems: () => [] });
      }
    };
  }, [navigation, props.placement, isTabActive]);

  return null;
}

function NativeHeaderToolbarButton(_props: {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: NativeHeaderToolbarIcon;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  /** "prominent" fills the button with its tint (iOS 26 and later). */
  readonly variant?: "plain" | "prominent";
}) {
  return null;
}
NativeHeaderToolbarButton.displayName = "NativeHeaderToolbarButton";

function NativeHeaderToolbarMenu(_props: {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly inline?: boolean;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly title?: string;
}) {
  return null;
}
NativeHeaderToolbarMenu.displayName = "NativeHeaderToolbarMenu";

function NativeHeaderToolbarMenuAction(_props: {
  readonly children?: ReactNode;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly discoverabilityLabel?: string;
  readonly icon?: string;
  readonly isOn?: boolean;
  readonly onPress?: () => void;
  readonly subtitle?: string;
}) {
  return null;
}
NativeHeaderToolbarMenuAction.displayName = "NativeHeaderToolbarMenuAction";

function NativeHeaderToolbarLabel(_props: { readonly children?: ReactNode }) {
  return null;
}
NativeHeaderToolbarLabel.displayName = "NativeHeaderToolbarLabel";

function NativeHeaderToolbarSpacer(_props: {
  readonly flexible?: boolean;
  readonly sharesBackground?: boolean;
  readonly width?: number;
}) {
  return null;
}
NativeHeaderToolbarSpacer.displayName = "NativeHeaderToolbarSpacer";

function NativeHeaderToolbarSearchBarSlot() {
  return null;
}
NativeHeaderToolbarSearchBarSlot.displayName = "NativeHeaderToolbarSearchBarSlot";

export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
