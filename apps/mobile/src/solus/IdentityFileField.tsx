import { getFilesystemBrowsePath } from "@t3tools/client-runtime/state/filesystem";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import { EnvironmentId } from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useState } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput as TextInput } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { ListRowLayout } from "../components/ui/ListRowLayout";
import { ListSection } from "../components/ui/ListSection";
import { RowPressable } from "../components/ui/RowPressable";
import { useEnvironmentQuery } from "../state/query";
import { browseHostFiles } from "./project-host";
import { solus } from "./runtime";
import { useCheckoutAccess } from "./use-checkout-files";

// The folder Browse opens first, as on desktop and web.
const KEYS_FOLDER = "~/.ssh/";

/** T3's browse helpers read Windows paths by this platform name. */
function browsePlatform(hostId: string): string {
  const os = solus.registry.host(hostId)?.os;
  return os === "windows" ? "Win32" : os === "macos" ? "MacIntel" : os === "linux" ? "Linux" : "";
}

/**
 * The Identity file field of an SSH add (`ssh -i`): a private key on the host
 * that runs SSH, never on this phone. Browse lists that host's files from
 * `~/.ssh/` with T3's folder browsing, and a tap on a file chooses it.
 */
export function IdentityFileField(props: {
  /** The host that runs SSH; null while there is none. */
  readonly hostId: string | null;
  readonly hostLabel: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** A refusal that belongs to this field, such as "No file at …". */
  readonly error: string | null;
  readonly disabled?: boolean;
}) {
  const [isBrowsing, setIsBrowsing] = useState(false);
  const hostId = props.hostId;
  return (
    <View className="gap-2">
      <Text className="px-1 text-sm font-t3-medium text-foreground-muted">Identity file (optional)</Text>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel="Identity file"
          className="flex-1"
          placeholder="~/.ssh/my-key.pem"
          value={props.value}
          onChangeText={(text) => props.onChangeText(resolvePastedPath(props.value, text))}
          editable={!props.disabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          label={isBrowsing ? "Close" : "Browse"}
          size="compact"
          tone="secondary"
          disabled={props.disabled || !hostId}
          onPress={() => setIsBrowsing(!isBrowsing)}
        />
      </View>
      {props.error ? (
        <Text accessibilityRole="alert" className="px-1 text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : (
        <Text className="px-1 text-sm text-foreground-muted">
          A private key on {props.hostLabel}, as with ssh -i. Empty: its SSH keys and ~/.ssh/config.
        </Text>
      )}
      {isBrowsing && hostId ? (
        <KeyFileBrowser
          hostId={hostId}
          onChoose={(path) => {
            props.onChangeText(path);
            setIsBrowsing(false);
          }}
        />
      ) : null}
    </View>
  );
}

/** The files of one folder on the host: ".." and folders open, a file is chosen. */
function KeyFileBrowser(props: { readonly hostId: string; readonly onChoose: (path: string) => void }) {
  const [path, setPath] = useState(KEYS_FOLDER);
  const browsePath = getFilesystemBrowsePath(path, browsePlatform(props.hostId));
  const access = useCheckoutAccess(props.hostId);
  const listing = useEnvironmentQuery(
    access.canReadFiles && browsePath.directoryPath
      ? browseHostFiles({
          environmentId: EnvironmentId.make(props.hostId),
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const parentPath = browsePath.canBrowseUp ? browsePath.parentPath : null;
  const entries = listing.data?.entries ?? [];
  return (
    <View className="gap-2">
      {!access.canReadFiles && !access.isPending ? (
        <ErrorBanner message={access.error ?? "This connection cannot browse host files."} />
      ) : null}
      {listing.error ? <ErrorBanner message={listing.error} /> : null}
      <ListSection title={browsePath.directoryPath}>
        {access.isPending || (listing.isPending && listing.data === null) ? (
          <View className="items-center py-5">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : null}
        {parentPath ? (
          <BrowseRow label=".." icon="arrow.turn.left.up" isFirst onPress={() => setPath(parentPath)} />
        ) : null}
        {entries.map((entry, index) => (
          <BrowseRow
            key={entry.fullPath}
            label={entry.name}
            icon={entry.isDir ? "folder" : "doc"}
            isFirst={index === 0 && !parentPath}
            onPress={() =>
              entry.isDir
                ? setPath(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                : props.onChoose(entry.fullPath)
            }
          />
        ))}
        {listing.data && entries.length === 0 ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">This folder is empty.</Text>
        ) : null}
      </ListSection>
    </View>
  );
}

function BrowseRow(props: {
  readonly label: string;
  readonly icon: "arrow.turn.left.up" | "folder" | "doc";
  readonly isFirst: boolean;
  readonly onPress: () => void;
}) {
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={props.isFirst ? "bg-grouped-card" : "border-t border-border-subtle bg-grouped-card"}
    >
      <ListRowLayout icon={props.icon} label={props.label} />
    </RowPressable>
  );
}
