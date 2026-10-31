import { useState } from 'react'
import { Linking, TextInput, View } from 'react-native'
import { EAS_SETUP_HELP } from '@solus/client-core/eas-setup-help'
import { tryCopyTextWithHaptic } from '../../lib/copyTextWithHaptic'
import type { CloudDeviceHostConfig, DeviceHostTestResult } from '@solus/contracts/device-types'
import { cloudDeviceHostConfigSchema, DEVICE_SECRET_SAVED } from '@solus/contracts/device-types'
import { useApp } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { SettingsActionRow } from '../settings/components/SettingsActionRow'
import { SettingsSection } from '../settings/components/SettingsSection'
import { SettingsNote } from '../settings/components/SettingsNote'

function Field(props: { label: string; value: string | number; change: (value: string) => void; secret?: boolean; numeric?: boolean; disabled: boolean }) {
  return <View className="gap-2 px-4 py-3">
    <Text className="text-base text-foreground">{props.label}</Text>
    <TextInput accessibilityLabel={props.label} value={String(props.value)} onChangeText={props.change} secureTextEntry={props.secret} autoCapitalize="none" autoCorrect={false} keyboardType={props.numeric ? 'number-pad' : 'default'} editable={!props.disabled} className="rounded-xl border border-border px-3 py-3 text-base text-foreground" />
  </View>
}
export function CloudDeviceHostEditor(props: { hostId: string; config: CloudDeviceHostConfig; close: () => void }) {
  const app = useApp()
  const [draft, setDraft] = useState(props.config)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<DeviceHostTestResult | null>(null)
  const [copied, setCopied] = useState(false)
  const canCheck = cloudDeviceHostConfigSchema.safeParse(draft).success
  const valid = canCheck && (draft.kind !== 'eas' || !!draft.appId)
  const update = (next: CloudDeviceHostConfig) => { setDraft(next); setChecked(null) }
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  return <View className="gap-3">
    <SettingsSection title={draft.kind === 'eas' ? 'EAS Simulator' : 'Simlock pool (alpha)'}>
      <Field label="Name" value={draft.label} change={(label) => update({ ...draft, label })} disabled={busy} />
      {draft.kind === 'eas' ? <>
        <View className="gap-3 px-4 py-3">
          <Text className="text-base font-medium text-foreground">Set up Expo</Text>
          <Text className="text-sm text-foreground-muted">{EAS_SETUP_HELP.location}</Text>
          <Text selectable className="font-mono text-sm text-foreground">{EAS_SETUP_HELP.commands}</Text>
          <Text className="text-sm text-foreground-muted">{EAS_SETUP_HELP.project}</Text>
          <Text className="text-sm text-foreground-muted">{EAS_SETUP_HELP.token}</Text>
          <Text className="text-sm text-foreground-muted">{EAS_SETUP_HELP.access}</Text>
        </View>
        <SettingsActionRow icon="doc.on.doc" label={copied ? 'Commands copied' : 'Copy setup commands'} onPress={() => void run(async () => {
          const success = await tryCopyTextWithHaptic(EAS_SETUP_HELP.commands)
          setCopied(success)
          if (!success) throw new Error('Could not copy setup commands. Select the command text to copy it.')
        })} />
        {EAS_SETUP_HELP.links.map((link) => <SettingsActionRow key={link.url} icon="safari" label={link.label} onPress={() => void run(async () => { await Linking.openURL(link.url) })} />)}
        {checked?.apps?.map((project) => <SettingsActionRow key={project.id} icon="folder" label={project.fullName} disabled={busy} onPress={() => setDraft({ ...draft, appId: project.id })} />)}
        <Field label="Expo project ID" value={draft.appId} change={(appId) => update({ ...draft, appId })} disabled={busy} />
        <Field label="Expo access token" value={draft.accessToken} change={(accessToken) => update({ ...draft, accessToken })} secret disabled={busy} />
        <Field label="Sessions at once (1–10)" value={draft.maxConcurrentSessions} change={(value) => update({ ...draft, maxConcurrentSessions: Number(value) })} numeric disabled={busy} />
        <Field label="Session minutes (2–115)" value={draft.maxSessionMinutes} change={(value) => update({ ...draft, maxSessionMinutes: Number(value) })} numeric disabled={busy} />
        <Field label="Idle minutes" value={draft.idleMinutes} change={(value) => update({ ...draft, idleMinutes: Number(value) })} numeric disabled={busy} />
      </> : <>
        <Field label="Gateway URL" value={draft.gatewayUrl} change={(gatewayUrl) => update({ ...draft, gatewayUrl })} disabled={busy} />
        <Field label="Agent token" value={draft.agentToken} change={(agentToken) => update({ ...draft, agentToken })} secret disabled={busy} />
        <Field label="Devices at once (1–20)" value={draft.maxLeases} change={(value) => update({ ...draft, maxLeases: Number(value) })} numeric disabled={busy} />
        <Field label="Lease minutes (5–240)" value={draft.maxLeaseMinutes} change={(value) => update({ ...draft, maxLeaseMinutes: Number(value) })} numeric disabled={busy} />
      </>}
      <SettingsActionRow icon="checkmark.circle" label="Check connection" loading={busy} disabled={busy || !canCheck} onPress={() => void run(async () => setChecked(await app.devices.test(props.hostId, cloudDeviceHostConfigSchema.parse(draft))))} />
      <SettingsActionRow icon="checkmark" label="Save source" disabled={busy || !valid} onPress={() => void run(async () => { await app.devices.save(props.hostId, cloudDeviceHostConfigSchema.parse(draft)); props.close() })} />
      <SettingsActionRow icon="xmark" label="Cancel" disabled={busy} onPress={props.close} />
    </SettingsSection>
    <SettingsNote>{draft.kind === 'eas' ? 'Opening a device starts a paid Expo session. A blank token uses EXPO_TOKEN on the host, then eas login. Idle minutes must be smaller than session minutes.' : 'Set up your Simlock gateway and workers first. Use an agent token for this Solus host. A blank token uses the host’s agent-device environment only when it names this gateway.'}</SettingsNote>
    {(draft.kind === 'eas' ? draft.accessToken : draft.agentToken) === DEVICE_SECRET_SAVED ? <SettingsNote>A token is saved. Keep it, replace it, or clear the field to use the host environment.</SettingsNote> : null}
    <SettingsNote>Saving changes stops this source’s current sessions or leases. Closing the last preview stops the EAS session or returns the Simlock device to the pool.</SettingsNote>
    {checked ? checked.checks.map((check) => <SettingsNote key={check.name}>{check.detail ?? (check.ok ? 'Connection checked.' : 'Connection failed.')}</SettingsNote>) : null}
    {error ? <Text accessibilityRole="alert" className="px-4 text-base text-danger-foreground">{error}</Text> : null}
  </View>
}
