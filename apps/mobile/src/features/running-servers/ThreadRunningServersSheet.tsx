import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { hostPathBaseName } from "@solus/contracts/host-path";
import { serverUrlsFromText, stopRefusalText } from "@solus/contracts/running-servers";
import { runningServerFolderPaths, type RunningServersController } from "@solus/client-core/running-servers";
import { useListened } from "@solus-mobile/app/app-context";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
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
  const mayStop = useListened(solus.connections.changes, () => solus.connections.may(environmentId, "host.admin"));
  const connectionGeneration = useListened(solus.connections.changes, () => solus.connections.state(environmentId)?.sessionGeneration);
  const [showOther, setShowOther] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingUrls, setEditingUrls] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [savingUrls, setSavingUrls] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const urlPath = selectedPath && checkoutPaths.includes(selectedPath) ? selectedPath : checkoutPaths[0];
  const { sessionRows, otherRows } = useMemo(
    () => store.rowsForScope({ checkoutPaths, sessionId: threadId }),
    [store, state, checkoutPaths, threadId],
  );
  const isShowingOther = showOther && otherRows.length > 0;
  const rows = isShowingOther ? otherRows : sessionRows;
  useEffect(() => {
    if (session && mayUse && focused) return store.retainCheckouts(checkoutPaths);
  }, [store, session, mayUse, focused, checkoutPaths]);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try { setMessage(await action() ?? null); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader title={editingUrls ? "Server URLs" : "Running servers"} onClose={() => navigation.goBack()} dismissDisabled={savingUrls} />
      <ScreenContent>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
          <View className="gap-3 px-4 py-3">
            {!session || !mayUse || store.status === "disconnected" ? (
              <AppText className="text-foreground-muted">Connect to this session’s host to see its servers.</AppText>
            ) : editingUrls && urlPath ? (
              <>
                <Button label="Back to servers" disabled={savingUrls} onPress={() => setEditingUrls(false)} />
                {checkoutPaths.length > 1 ? checkoutPaths.map((path) => (
                  <Pressable key={path} accessibilityRole="radio" accessibilityState={{ selected: path === urlPath, disabled: savingUrls }} disabled={savingUrls}
                    onPress={() => setSelectedPath(path)} className="rounded-xl bg-secondary p-3">
                    <AppText>{path === urlPath ? "✓ " : ""}{path}</AppText>
                  </Pressable>
                )) : null}
                <ServerUrlsForm key={JSON.stringify([connectionGeneration, urlPath])} store={store} path={urlPath} saving={savingUrls}
                  onSaving={setSavingUrls} onSaved={() => setEditingUrls(false)} />
              </>
            ) : (
              <>
                {store.status === "loading" ? <AppActivityIndicator accessibilityLabel="Finding servers" /> : null}
                {store.status === "error" ? (
                  <>
                    <AppText accessibilityRole="alert">{store.error}</AppText>
                    <Button label="Retry" onPress={() => store.retry()} />
                  </>
                ) : null}
                {store.status === "ready" && rows.length === 0 ? (
                  <AppText className="text-foreground-muted">No servers in this session.</AppText>
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
                {otherRows.length ? (
                  <Button label={isShowingOther ? "Session folders" : `${otherRows.length} in other checkouts`} onPress={() => {
                    setShowOther(!isShowingOther);
                    setExpanded(false);
                  }} />
                ) : null}
                {urlPath ? <Button label="Server URLs" onPress={() => setEditingUrls(true)} /> : null}
              </>
            )}
          </View>
        </ScrollView>
      </ScreenContent>
    </View>
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
