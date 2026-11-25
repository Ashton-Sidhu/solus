import type { Codebase } from "@solus/contracts/codebases";
import { codebaseMark } from "@solus/contracts/codebase-badge";
import { useGT } from "gt-react-native";
import { Platform, View } from "react-native";

import { CodebaseBadge } from "../../components/ProjectFavicon";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { codebasePickerDestinations } from "../../solus/codebase-picker";

type Destination = ReturnType<typeof codebasePickerDestinations>[number];

export function NewTaskCodebaseRows(props: {
  readonly rows: readonly { codebase: Codebase; destinations: readonly Destination[] }[];
  readonly preferredHostId: string | null;
  readonly currentCodebaseId: string | null;
  readonly disabled: boolean;
  readonly onChoose: (codebaseId: string, hostId: string, path?: string) => void;
  readonly onClear?: () => void;
}) {
  const gt = useGT();
  return (
    <View className="gap-2">
      <Text className="px-4 text-sm font-t3-medium text-foreground-muted">{gt("Codebases")}</Text>
      <View
        className={Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-[24px] bg-grouped-card"}
      >
        {props.rows.map(({ codebase, destinations }) => {
          const preferred = destinations.find((host) => host.hostId === props.preferredHostId);
          const direct = preferred?.isReady ? preferred : undefined;
          const canChooseHost = !direct && destinations.some((host) => host.isReady);
          const isSelected = codebase.id === props.currentCodebaseId;
          const row = (
            <NavigationRow
              className="bg-grouped-card"
              title={codebase.name}
              subtitle={direct?.path ?? (canChooseHost ? gt("Choose a folder on another host") : gt("No folder on a connected host"))}
              subtitleNumberOfLines={1}
              subtitleEllipsizeMode="middle"
              accessibilityLabel={codebase.name}
              accessibilityState={{ selected: isSelected, disabled: props.disabled || (!direct && !canChooseHost) }}
              disabled={props.disabled || (!direct && !canChooseHost)}
              onPress={direct ? () => props.onChoose(codebase.id, direct.hostId) : undefined}
              leading={<CodebaseBadge mark={codebaseMark(codebase)} size={24} />}
              trailing={isSelected ? <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" /> : undefined}
            />
          );
          if (!canChooseHost || props.disabled) return <View key={codebase.id}>{row}</View>;
          const folders = destinations.flatMap((host) => host.roots.map((root) => ({
            id: JSON.stringify([host.hostId, root.path]),
            hostId: host.hostId,
            path: root.path,
            title: host.roots.length > 1
              ? gt("{folder} on {host}", { folder: root.name, host: host.label })
              : host.label,
            attributes: { disabled: !host.isReady },
          })));
          return (
            <Menu
              key={codebase.id}
              title={codebase.name}
              accessibilityLabel={codebase.name}
              actions={folders.map(({ id, title, path, attributes }) => ({
                id, title, subtitle: path, attributes,
              }))}
              onPressAction={({ nativeEvent }) => {
                const folder = folders.find(({ id }) => nativeEvent.event === id);
                if (folder && !folder.attributes.disabled) props.onChoose(codebase.id, folder.hostId, folder.path);
              }}
            >
              {row}
            </Menu>
          );
        })}
        {props.onClear ? (
          <NavigationRow
            className="bg-grouped-card"
            title={gt("No codebase")}
            disabled={props.disabled}
            onPress={props.onClear}
            leading={<SymbolView name="folder" size={20} tintColorClassName="accent-icon-muted" />}
          />
        ) : null}
      </View>
    </View>
  );
}
