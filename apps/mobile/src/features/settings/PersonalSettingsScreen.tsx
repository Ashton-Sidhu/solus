import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { EnableOffer, EnableOutcome } from '@solus/client-core/settings-sync'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { ActionRow, ChoiceRow, GroupedFooter, GroupedScroll, GroupedSection, NavigationRow, SwitchRow, ValueRow } from '../../ui/grouped-rows'
import { enableChoicesFor, type EnableChoiceKind } from './personal-sync'
import { SYNC_STATE_LABELS } from './lib/settings-labels'
import { settingKeyLabel, settingValueText, syncStatusDetail } from './lib/sync-text'

const ENABLE_CHOICE_TEXT = {
  'use-synced': { label: 'Use synced settings', description: 'This device takes the settings your account already has.' },
  replace: { label: 'Replace with this device', description: 'Your account and your other synced devices take this device’s settings.' },
  seed: { label: 'Start with this device', description: 'Your account has no synced settings yet. This device’s settings become them.' },
} as const satisfies Record<EnableChoiceKind, { label: string; description: string }>

const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString()

/**
 * Sync of the person's settings on this device (plans/018 §5, §7). Off until
 * the person turns it on here; signing in does not. The first enable reads the
 * account first and offers a choice; nothing is overwritten without one. Works
 * without any host.
 */
export function PersonalSettingsScreen({ navigation }: ScreenProps<'PersonalSettings'>) {
  const app = useApp()
  const sync = app.personalSync
  const status = useListened(sync.changes, sync.current)
  const [offer, setOffer] = useState<EnableOffer | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  // Settings opened: read the account now (the engine ignores this while sync is off).
  useFocusEffect(useCallback(() => { void sync.engine.refresh() }, [sync]))

  const isOn = !['signed-out', 'off', 'loading'].includes(status.state)
  const isSignedIn = status.state !== 'signed-out'

  const startEnable = async () => {
    setMessage('')
    setBusy(true)
    const outcome = await sync.engine.prepareEnable()
    setBusy(false)
    if (outcome.kind === 'offer') setOffer(outcome.offer)
    else if (outcome.kind !== 'cancelled') setMessage(unavailableText(outcome))
  }

  const choose = async (kind: EnableChoiceKind) => {
    setBusy(true)
    const outcome = await sync.enable(kind)
    setBusy(false)
    handleEnable(outcome)
  }

  const handleEnable = (outcome: EnableOutcome) => {
    if (outcome.kind === 'enabled' || outcome.kind === 'cancelled') {
      setOffer(null)
      setMessage('')
    } else if (outcome.kind === 'changed') {
      setOffer(outcome.offer)
      setMessage('Your synced settings changed a moment ago. Nothing was overwritten. Choose again.')
    } else if (outcome.kind === 'invalid') {
      setOffer(null)
      setMessage('These settings could not be sent. Nothing was changed.')
    } else {
      setMessage(unavailableText(outcome))
    }
  }

  const confirmChoice = (kind: EnableChoiceKind) => {
    if (kind !== 'replace') return void choose(kind)
    Alert.alert('Replace synced settings?', 'Your account and your other synced devices take this device’s settings.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace', style: 'destructive', onPress: () => void choose(kind) },
    ])
  }

  const toggle = (next: boolean) => {
    if (next) return void startEnable()
    Alert.alert('Turn off sync on this device?', 'Your settings stay on this device. Your account and your other devices keep theirs.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => sync.engine.turnOff() },
    ])
  }

  const clear = async (discardUnsent: boolean) => {
    setBusy(true)
    const outcome = await sync.engine.clearCloud({ discardUnsent })
    setBusy(false)
    if (outcome.kind === 'has-unsent') {
      Alert.alert('Discard unsent changes?', `${outcome.keys.length === 1 ? '1 change has' : `${outcome.keys.length} changes have`} not synced yet. Clearing discards them from your account; they stay on this device.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => void clear(true) },
      ])
    } else if (outcome.kind === 'cleared') {
      setOffer(null)
      setMessage('Synced settings were cleared. Your other devices stop syncing when they next connect.')
    } else if (outcome.kind !== 'cancelled') {
      setMessage(unavailableText(outcome))
    }
  }

  const confirmClear = () => Alert.alert('Clear synced settings?', 'Your account’s copy is deleted and sync turns off on every device. Each device keeps its own settings.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: () => void clear(false) },
  ])

  return (
    <GroupedScroll>
      <GroupedSection title="Sync" footer={syncStatusDetail(status, formatTime)}>
        {isSignedIn ? (
          <SwitchRow icon="sync" label="Sync settings on this device" subtitle={SYNC_STATE_LABELS[status.state]} value={isOn || offer !== null} disabled={busy || status.state === 'loading'} onChange={toggle} />
        ) : (
          <NavigationRow icon="signIn" label="Sign in to Solus Cloud" accessibilityHint="Sync needs your account" onPress={() => navigation.navigate('CloudSignIn')} />
        )}
      </GroupedSection>

      {message ? <GroupedFooter tone="danger" text={message} /> : null}

      {offer && !isOn ? (
        <GroupedSection title="Turn on sync" footer={offer.kind === 'present' && offer.updatedAt ? `Your account’s settings were last changed ${formatTime(offer.updatedAt)}.` : undefined}>
          {enableChoicesFor(offer).map((kind, index) => (
            <ChoiceRow key={kind} isFirst={index === 0} label={ENABLE_CHOICE_TEXT[kind].label} description={ENABLE_CHOICE_TEXT[kind].description} selected={false} disabled={busy} onPress={() => confirmChoice(kind)} />
          ))}
          <ActionRow isFirst={false} label="Cancel" disabled={busy} onPress={() => setOffer(null)} />
        </GroupedSection>
      ) : null}

      {isOn ? (
        <GroupedSection title="Status">
          <ValueRow label="Status" value={SYNC_STATE_LABELS[status.state]} />
          <ValueRow isFirst={false} label="Last synced" value={status.lastSyncedAt === null ? 'Never' : formatTime(status.lastSyncedAt)} />
          <ValueRow isFirst={false} label="Waiting to send" value={String(status.pendingKeys.length)} />
          <ActionRow icon="refresh" isFirst={false} label="Sync now" tone="accent" disabled={busy} onPress={() => void sync.engine.refresh()} />
        </GroupedSection>
      ) : null}

      {status.conflicts.map((conflict) => (
        <GroupedSection
          key={conflict.key}
          title={settingKeyLabel(conflict.key)}
          footer={`On this device: ${settingValueText(conflict.mine, conflict.key)}. Synced: ${settingValueText(conflict.theirs, conflict.key)}.`}
        >
          <ActionRow label="Keep this device’s" tone="accent" onPress={() => sync.engine.resolveConflict(conflict.key, 'keep-mine')} />
          <ActionRow isFirst={false} label="Use synced" onPress={() => sync.engine.resolveConflict(conflict.key, 'take-theirs')} />
        </GroupedSection>
      ))}

      {isSignedIn ? (
        <GroupedSection footer="Deletes your account’s copy. Every device keeps its own settings and stops syncing.">
          <ActionRow icon="delete" label="Clear synced settings" tone="danger" busy={busy} onPress={confirmClear} />
        </GroupedSection>
      ) : null}
    </GroupedScroll>
  )
}

function unavailableText(outcome: { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'error'; code: string; message: string | null }): string {
  if (outcome.kind === 'signed-out') return 'Sign in to Solus Cloud again to sync.'
  if (outcome.kind === 'offline') return 'Solus Cloud did not answer. Check your connection and try again.'
  return `Solus Cloud refused: ${outcome.message ?? outcome.code}.`
}
