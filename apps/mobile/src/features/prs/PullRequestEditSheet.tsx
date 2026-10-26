import { useMemo, useRef, useState } from 'react'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { MaterialButton } from '../../components/MaterialButton'
import type { ScreenProps } from '../../navigation/routes'
import { pullRequestPermissions } from './lib/pull-request-permissions'
import { shownValue } from './pull-request-reads'
import { OFFLINE_REASON } from './detail/pull-request-view'
import { PullRequestSheetContent } from './detail/PullRequestSheetContent'

/**
 * Changes the title or the description of a pull request, as the web
 * client's Edit does. The field starts from the text the device holds; a
 * title cannot be empty. The sheet closes when the host takes the change.
 */
export function PullRequestEditSheet({ navigation, route }: ScreenProps<'PullRequestEdit'>) {
  const { hostId, projectPath, number, field } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const editingTitle = field === 'title'
  const app = useApp()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === 'ready')
  const pr = shownValue(state)?.overview.pullRequest ?? null
  const permissions = pullRequestPermissions(pr, viewerLogin, connected)
  const current = pr ? (editingTitle ? pr.title : pr.body) : ''
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const text = draft ?? current
  const value = editingTitle ? text.trim() : text
  const canSave = !!pr && permissions.canEditPullRequest && !busy && draft !== null && value !== current && (!editingTitle || value !== '')

  const save = async () => {
    if (!canSave || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so catch and finally see both.
    await (async () => {
      await app.pullRequestActions.update(ref, editingTitle ? { title: value } : { body: value })
      navigation.goBack()
    })().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'GitHub could not take this change. Try again.')
    }).finally(() => {
      pending.current = false
      setBusy(false)
    })
  }

  return (
    <PullRequestSheetContent
      title={editingTitle ? 'Edit title' : 'Edit description'}
      subtitle={`#${number}`}
      busy={busy}
      footer={<MaterialButton label={busy ? 'Saving…' : 'Save'} fullWidth tone="primary" loading={busy} disabled={!canSave} onPress={() => void save()} />}
    >
      <EditField editingTitle={editingTitle} editable={!busy && permissions.canEditPullRequest} text={text} onChange={setDraft} onSubmit={() => void save()} />
      <EditNotes connected={connected} reading={connected && !pr} titleMissing={editingTitle && draft !== null && value === ''} error={error} />
    </PullRequestSheetContent>
  )
}

/** The text field: one line for the title, many for the description. */
function EditField(props: { readonly editingTitle: boolean; readonly editable: boolean; readonly text: string; readonly onChange: (text: string) => void; readonly onSubmit: () => void }) {
  if (props.editingTitle) {
    return (
      <TextInput
        autoFocus
        accessibilityLabel="Pull request title"
        placeholder="Title"
        placeholderTextColorClassName="accent-placeholder"
        editable={props.editable}
        value={props.text}
        maxLength={1024}
        returnKeyType="done"
        onChangeText={props.onChange}
        onSubmitEditing={props.onSubmit}
        className="rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
      />
    )
  }
  return (
    <TextInput
      multiline
      autoFocus
      accessibilityLabel="Pull request description"
      placeholder="Describe this pull request…"
      placeholderTextColorClassName="accent-placeholder"
      editable={props.editable}
      value={props.text}
      maxLength={65536}
      onChangeText={props.onChange}
      className="min-h-48 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
      style={{ textAlignVertical: 'top' }}
    />
  )
}

/** Why the save is off, and the host's reason when a save failed. */
function EditNotes(props: { readonly connected: boolean; readonly reading: boolean; readonly titleMissing: boolean; readonly error: string | null }) {
  return (
    <>
      {!props.connected ? <Text className="px-1 text-xs text-foreground-muted">{OFFLINE_REASON}</Text> : null}
      {props.reading ? <Text className="px-1 text-xs text-foreground-muted">Reading the pull request…</Text> : null}
      {props.titleMissing ? <Text className="px-1 text-xs text-foreground-muted">A pull request needs a title.</Text> : null}
      {props.error ? <Text selectable className="px-1 text-sm text-danger-foreground">{props.error}</Text> : null}
    </>
  )
}
