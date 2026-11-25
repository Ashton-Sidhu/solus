import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { hostPathBaseName } from "@solus/contracts/host-path";
import { serverUrlsFromText, stopRefusalText } from "@solus/contracts/running-servers";
import { runningServerFolderPaths, type RunningServersController, type RunningServersRow } from "@solus/client-core/running-servers";
import { useListened } from "@solus-mobile/app/app-context";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ContentStatus } from "../../components/ui/ContentBand";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { solus } from "../../solus/runtime";
import { useSessionFolders, useSessionStore } from "../../solus/use-session-controller";
import { runningServersFor } from "./running-servers-store";

const noSubscribe = () => () => {};
const shownByDefault = 4;

type Target = { environmentId: string; threadId: string };

export function ThreadRunningServersSheet({ route }: StaticScreenProps<Target>) {
  const target = route.params;
  const scope = useListened(solus.account.changes, solus.sessionCache.scope);
  return <RunningServersSheet key={JSON.stringify([scope, target.environmentId, target.threadId])} target={target} />;
}

function RunningServersSheet({ target }: { target: Target }) {
  const { environmentId, threadId } = target;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const session = useSessionStore(target);
  const cwd = useSyncExternalStore(session?.meta.subscribe ?? noSubscribe, () => session?.metaSnapshotOf().run.workingDirectory);
  const folders = useSessionFolders(target);
  const checkoutPaths = useMemo(() => runningServerFolderPaths(cwd, folders), [cwd, folders]);
  const store = runningServersFor(environmentId);
  const state = useSyncExternalStore(store.subscribe, () => store.revision);
  const mayUse = useListened(solus.connections.changes, () => solus.connections.may(environmentId, "host.use"));
  const connectionGeneration = useListened(solus.connections.changes, () => solus.connections.state(environmentId)?.sessionGeneration);
  const [showOther, setShowOther] = useState(false);
  const [editingUrls, setEditingUrls] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [savingUrls, setSavingUrls] = useState(false);
  const urlPath = selectedPath && checkoutPaths.includes(selectedPath) ? selectedPath : checkoutPaths[0];
  const { sessionRows, otherRows } = useMemo(
    () => store.rowsForScope({ checkoutPaths, sessionId: threadId }),
    [store, state, checkoutPaths, threadId],
  );
  useEffect(() => {
    if (session && mayUse && focused) return store.retainCheckouts(checkoutPaths);
  }, [store, session, mayUse, focused, checkoutPaths]);

  const editUrls = session && mayUse && store.status !== "disconnected" && urlPath && !editingUrls
    ? () => setEditingUrls(true)
    : undefined;

  const isShowingOther = showOther && otherRows.length > 0;
  const rows = isShowingOther ? otherRows : sessionRows;
  const isEmpty = store.status === "ready" && rows.length === 0;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={editingUrls ? "Server URLs" : "Running servers"} onClose={() => navigation.goBack()}
        dismissDisabled={savingUrls}
        actions={editUrls && !isEmpty ? [{ accessibilityLabel: "Server URLs", icon: "link", onPress: editUrls }] : undefined}
      />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1 bg-screen"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-3 px-5 pt-3"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {!session || !mayUse || store.status === "disconnected" ? (
            <EmptyState
              variant="plain"
              title="Host disconnected"
              detail="Connect to this session’s host to see its servers."
            />
          ) : editingUrls && urlPath ? (
            <>
              <Button label="Back to servers" disabled={savingUrls} onPress={() => setEditingUrls(false)} />
              {checkoutPaths.length > 1 ? checkoutPaths.map((path) => (
                <Pressable key={path} accessibilityRole="radio" accessibilityState={{ checked: path === urlPath, disabled: savingUrls }} disabled={savingUrls}
                  onPress={() => setSelectedPath(path)} className="rounded-xl bg-secondary p-3">
                  <AppText>{path === urlPath ? "✓ " : ""}{path}</AppText>
                </Pressable>
              )) : null}
              <ServerUrlsForm key={JSON.stringify([connectionGeneration, urlPath])} store={store} path={urlPath} saving={savingUrls}
                onSaving={setSavingUrls} onSaved={() => setEditingUrls(false)} />
            </>
          ) : (
            <RunningServerList
              target={target}
              store={store}
              rows={rows}
              isEmpty={isEmpty}
              otherCount={otherRows.length}
              isShowingOther={isShowingOther}
              onToggleOther={() => setShowOther(!isShowingOther)}
              onEditUrls={editUrls}
            />
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function RunningServerList({ target, store, rows, isEmpty, otherCount, isShowingOther, onToggleOther, onEditUrls }: {
  target: Target;
  store: RunningServersController;
  rows: readonly RunningServersRow[];
  isEmpty: boolean;
  otherCount: number;
  isShowingOther: boolean;
  onToggleOther: () => void;
  onEditUrls?: () => void;
}) {
  const { environmentId } = target;
  const navigation = useNavigation();
  const mayStop = useListened(solus.connections.changes, () => solus.connections.may(environmentId, "host.admin"));
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try { setMessage(await action() ?? null); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return (
    <>
      {store.status === "loading" ? (
        <ContentStatus loading detail="Finding running servers…" />
      ) : null}
      {store.status === "error" ? (
        <>
          <AppText accessibilityRole="alert">{store.error}</AppText>
          <Button label="Retry" onPress={() => store.retry()} />
        </>
      ) : null}
      {isEmpty ? (
        <EmptyState
          variant="plain"
          title="No running servers"
          detail="Start a server in a session folder or add a URL to watch."
          actionLabel="Server URLs"
          onAction={onEditUrls}
        />
      ) : null}
      {message ? <AppText accessibilityLiveRegion="polite">{message}</AppText> : null}
      {(expanded ? rows : rows.slice(0, shownByDefault)).map(({ server, endpoint, label, checkoutPath }) => {
        const folder = server.location.projectRoot ?? checkoutPath;
        const name = endpoint.response?.pageTitle || server.process.name;
        return (
          <View className="gap-2 rounded-xl bg-secondary p-3" key={JSON.stringify([server.serverId, endpoint.endpointId])}>
            <AppText className="font-t3-medium">{name} · {label}</AppText>
            <AppText className="text-foreground-muted" numberOfLines={1}>
              {folder ? `${hostPathBaseName(folder) || folder} · ` : ""}{server.sourceLabel}
            </AppText>
            <View className="flex-row flex-wrap gap-2">
              <Button label="Open" accessibilityLabel={`Open ${name} ${label}`} disabled={busy} size="compact" onPress={() => void run(async () => {
                const tabId = await solus.browser.open(environmentId, endpoint.url);
                if (navigation.isFocused()) navigation.navigate("ThreadBrowserPreview", { ...target, tabId });
              })} />
              <Button label="Copy URL" disabled={busy} size="compact" onPress={() => void run(async () => {
                await Clipboard.setStringAsync(endpoint.url);
                return "Copied server URL.";
              })} />
              {mayStop && server.actions.canStop ? (
                <Button label="Stop" tone="danger" disabled={busy} size="compact" onPress={() => void run(async () => {
                  const result = await server.stop();
                  return result.status === "refused" ? stopRefusalText(result.reason) : "Server stopped.";
                })} />
              ) : null}
            </View>
          </View>
        );
      })}
      {rows.length > shownByDefault ? (
        <Button label={expanded ? "Show less" : `Show ${rows.length - shownByDefault} more`} onPress={() => setExpanded(!expanded)} />
      ) : null}
      {otherCount ? (
        <Button label={isShowingOther ? "Session folders" : `${otherCount} in other checkouts`} onPress={() => {
          onToggleOther();
          setExpanded(false);
        }} />
      ) : null}
    </>
  );
}

function ServerUrlsForm({ store, path, saving, onSaving, onSaved }: {
  store: RunningServersController;
  path: string;
  saving: boolean;
  onSaving: (saving: boolean) => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void store.configuredUrls(path).then(
      (urls) => { if (active) setValue(urls.join("\n")); },
      (cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { active = false; };
  }, [store, path, attempt]);

  async function save() {
    if (value === null) return;
    onSaving(true);
    setError(null);
    try { await store.configureUrls(path, serverUrlsFromText(value)); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { onSaving(false); }
  }

  return (
    <>
      <AppText className="text-foreground-muted">Enter one local HTTP or HTTPS URL per line.</AppText>
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
      {value === null ? error ? <Button label="Retry" onPress={() => { setError(null); setAttempt(attempt + 1); }} /> : <AppActivityIndicator accessibilityLabel="Loading server URLs" /> : (
        <>
          <AppTextInput accessibilityLabel="Server URLs" value={value} onChangeText={setValue} editable={!saving}
            multiline autoCapitalize="none" autoCorrect={false} className="min-h-28 rounded-xl bg-secondary p-3" />
          <Button label="Save" tone="primary" loading={saving} onPress={() => void save()} />
        </>
      )}
    </>
  );
}
