// Adapted from T3 Code apps/mobile/src/components/ui/menuActionItems.ts (MIT, see UPSTREAM.md).
import type { MenuAction } from "@react-native-menu/menu";
import type { ScreenHeaderMenuItem } from "./ScreenHeader.types";

/** Adapts header menu items to a `ControlPillMenu`'s actions; `findMenuItem` resolves a selection. */
export function menuActionsFromItems(items: ReadonlyArray<ScreenHeaderMenuItem>): MenuAction[] {
  return items.flatMap((item): MenuAction[] =>
    "items" in item
      ? item.inline && !item.title
        ? menuActionsFromItems(item.items)
        : [
            {
              id: item.id,
              title: item.title ?? "",
              image: item.icon,
              displayInline: item.inline,
              subactions: menuActionsFromItems(item.items),
            },
          ]
      : [
          {
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            image: item.icon,
            state: item.selected ? "on" : undefined,
            attributes:
              item.disabled || item.destructive
                ? { disabled: item.disabled, destructive: item.destructive }
                : undefined,
          },
        ],
  );
}

export function findMenuItem(
  items: ReadonlyArray<ScreenHeaderMenuItem>,
  id: string,
): Extract<ScreenHeaderMenuItem, { readonly onPress: () => void }> | undefined {
  for (const item of items) {
    if ("items" in item) {
      const action = findMenuItem(item.items, id);
      if (action) return action;
    } else if (item.id === id) {
      return item;
    }
  }
  return undefined;
}
