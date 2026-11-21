import type { ReactNode } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "./AppText";
import type { SheetHeaderProps } from "./SheetHeader.types";

/**
 * The composer's "search and pick" page sheet: a header, a search field, and
 * a list of rows to pick from. A pick that needs values shows a form in the
 * same sheet, with a way back to the list and a confirmation (Send, Attach).
 * `SheetHeader` draws a route's native bar; this sheet is a modal over the
 * thread, so it draws its own header.
 */
export function PickSheet(props: {
  readonly title: string;
  /** The title names code (a command, an address): centered, in mono. */
  readonly titleIsCode?: boolean;
  /** Back to the list from a form. */
  readonly back?: { readonly label: string; readonly disabled?: boolean; readonly onPress: () => void };
  /** In place of Cancel: the form's confirmation. */
  readonly confirm?: NonNullable<SheetHeaderProps["confirm"]> & { readonly accessibilityLabel: string };
  /** The list's search field; absent while a form shows. */
  readonly search?: { readonly label: string; readonly query: string; readonly autoFocus?: boolean; readonly onChange: (query: string) => void };
  readonly error?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { back, confirm, search } = props;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
        <View className="h-14 flex-row items-center gap-3 px-5">
          {back ? (
            <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={back.onPress} disabled={back.disabled}>
              <Text className="text-primary">{back.label}</Text>
            </Pressable>
          ) : null}
          <Text numberOfLines={1} className={`flex-1 font-t3-semibold text-base text-foreground ${props.titleIsCode ? "text-center font-mono" : ""}`}>
            {props.title}
          </Text>
          {confirm ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirm.accessibilityLabel}
              className="py-2 active:opacity-70"
              disabled={confirm.disabled || confirm.loading}
              onPress={confirm.onPress}
            >
              <Text className={`font-t3-semibold ${confirm.loading ? "text-foreground-muted" : "text-primary"}`}>{confirm.label}</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={props.onClose}>
              <Text className="text-primary">Cancel</Text>
            </Pressable>
          )}
        </View>
        {props.error ? <Text accessibilityRole="alert" className="px-5 pb-2 text-sm text-danger">{props.error}</Text> : null}
        {search ? (
          <TextInput
            accessibilityLabel={search.label}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={search.autoFocus}
            clearButtonMode="while-editing"
            onChangeText={search.onChange}
            placeholder={search.label}
            placeholderTextColorClassName="accent-placeholder"
            returnKeyType="search"
            className="mx-5 mb-2 h-[40px] rounded-xl bg-subtle px-3 font-sans text-base text-foreground"
            value={search.query}
          />
        ) : null}
        {props.children}
      </View>
    </Modal>
  );
}

/** One row of a pick sheet's list. */
export function PickRow(props: { readonly disabled?: boolean; readonly onPress: () => void; readonly children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" disabled={props.disabled} className="gap-1 border-b border-border px-5 py-3 active:opacity-70" onPress={props.onPress}>
      {props.children}
    </Pressable>
  );
}
