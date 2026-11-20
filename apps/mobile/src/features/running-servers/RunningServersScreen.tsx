import { SERVER_LIST_PAGE_SIZE, serverUrlsFromText, type ServerEndpoint } from '@solus/contracts/running-servers';
import { runningServers } from './running-servers.store';
import type { RunningServers } from '@solus/client-core/running-servers';
import { hostPathBaseName } from '@solus/contracts/host-path';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useApp, useListened } from '../../app/app-context';
import { AppText as Text } from '../../components/AppText';
import { ScreenScrollView } from '../../components/ScreenScrollView';
import type { ScreenProps } from '../../navigation/routes';
import { SettingsScreen } from '../settings/components/SettingsScreen';
import { SettingsSection } from '../settings/components/SettingsSection';
import { useAppForeground } from '../../lib/appState';

export function RunningServersScreen({ route, navigation }: ScreenProps<'RunningServers'>) {
  const { hostId, sessionId, checkoutPath } = route.params;
  const app = useApp();
  const store = runningServers.forHost(app.connections, hostId);
  const foreground = useAppForeground();
  useSyncExternalStore(store.subscribe, () => store.revision, () => store.revision);
  const mayStop = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin'));
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingUrls, setEditingUrls] = useState(false);
  const [urlText, setUrlText] = useState('');
  const [savingUrls, setSavingUrls] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useFocusEffect(useCallback(() => foreground ? store.retainCheckout(checkoutPath) : undefined, [store, foreground, checkoutPath]));
  const rows = store.rows(showAll ? undefined : checkoutPath);
  const visibleRows = expanded ? rows : rows.slice(0, SERVER_LIST_PAGE_SIZE);
  const fail = (message: string) => Alert.alert('Server action failed', message);
  const editUrls = async () => {
    if (!checkoutPath) return;
    try { setUrlText((await store.configuredUrls(checkoutPath)).join('\n')); setEditingUrls(true); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const saveUrls = async () => {
    if (!checkoutPath) return;
    setSavingUrls(true);
    try { await store.configureUrls(checkoutPath, serverUrlsFromText(urlText)); setEditingUrls(false); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setSavingUrls(false); }
  };
  const open = async (server: RunningServers, endpoint: ServerEndpoint) => {
    try {
      const connection = app.connections.connection(hostId);
      if (!connection) throw new Error('This host is disconnected.');
      const page = await connection.api.browserOpen({ target: {
        kind: 'url', url: endpoint.url,
        projectRoot: server.location.projectRoot ?? undefined,
        worktreePath: server.location.worktreePath ?? undefined,
        branch: server.location.branch ?? undefined,
      }});
      navigation.navigate('ThreadBrowserPreview', { hostId, sessionId, browserPageId: page.browserPageId });
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  };
  const stop = async (server: RunningServers) => {
    setBusy(server.serverId);
    try {
      const result = await server.stop();
      if (result.status === 'refused') Alert.alert('Cannot stop server', result.reason === 'identity-changed' ? 'The process changed. Read the server list again.' : 'This process is not eligible to stop.');
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  return (
    <SettingsScreen title="Running servers">
      <ScreenScrollView contentContainerClassName="gap-5 px-4 py-4">
        <Pressable accessibilityRole="button" onPress={() => { setShowAll(!showAll); setExpanded(false); }} className="self-start rounded-xl bg-grouped-card px-4 py-3">
          <Text className="text-base text-foreground">{showAll ? 'Show this checkout' : 'Show all servers on host'}</Text>
        </Pressable>
        {store.status === 'loading' ? <Text className="text-sm text-foreground-muted">Checking servers…</Text> : null}
        {store.status === 'disconnected' ? <Text className="text-sm text-foreground-muted">Host disconnected</Text> : null}
        {store.status === 'error' ? <Pressable accessibilityRole="button" onPress={() => store.retry()}><Text className="text-sm text-foreground-muted">{store.error} Tap to retry.</Text></Pressable> : null}
        {store.status === 'ready' && rows.length === 0 ? <Text className="text-sm text-foreground-muted">No running servers</Text> : null}
        {checkoutPath ? <Pressable accessibilityRole="button" onPress={() => void editUrls()}><Text className="text-sm text-foreground-muted">Server URLs…</Text></Pressable> : null}
        {editingUrls ? <View className="gap-3 rounded-xl bg-grouped-card p-4">
          <Text className="text-sm text-foreground-muted">One local HTTP or HTTPS URL per line. Paths and query strings are kept.</Text>
          <TextInput accessibilityLabel="Server URLs" multiline autoCapitalize="none" autoCorrect={false} value={urlText} onChangeText={setUrlText} editable={!savingUrls} className="min-h-28 text-base text-foreground" />
          <Pressable accessibilityRole="button" disabled={savingUrls} onPress={() => void saveUrls()}><Text className="text-base text-foreground">{savingUrls ? 'Saving…' : 'Save URLs'}</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={savingUrls} onPress={() => setEditingUrls(false)}><Text className="text-base text-foreground-muted">Cancel</Text></Pressable>
        </View> : null}
        {visibleRows.map(({ server, endpoint, checkoutPath: path, label }) => (
          <SettingsSection key={`${server.serverId}:${endpoint.endpointId}`} title={showAll && path ? hostPathBaseName(path) : undefined}>
            <View className="gap-2 p-4">
              <Text className="text-base font-t3-medium text-foreground">{server.process.name}</Text>
              <Text className="text-sm text-foreground-muted">{server.sourceLabel}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open server on port ${endpoint.port}`} onPress={() => void open(server, endpoint)} className="py-2">
                <Text className="text-base text-foreground">{endpoint.response?.pageTitle || label}</Text>
                <Text className="text-sm text-foreground-muted">{endpoint.url}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => { void Clipboard.setStringAsync(endpoint.url).catch((error) => fail(error instanceof Error ? error.message : String(error))); }} className="self-start py-2"><Text className="text-sm text-foreground-muted">Copy host URL</Text></Pressable>
              {mayStop && server.actions.canStop ? <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void stop(server)} className="self-start py-2 disabled:opacity-40"><Text className="text-sm text-danger-foreground">{busy === server.serverId ? 'Stopping…' : 'Stop server'}</Text></Pressable> : null}
            </View>
          </SettingsSection>
        ))}
        {rows.length > SERVER_LIST_PAGE_SIZE ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}><Text className="text-sm text-foreground-muted">{expanded ? 'Show less' : `Show ${rows.length - SERVER_LIST_PAGE_SIZE} more`}</Text></Pressable> : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
