import { useState } from 'react'
import { Text, View } from 'react-native'
import type { Integration, IntegrationEnvValue, IntegrationLaunch } from '@solus/contracts/integration-types'
import { splitCommandLine } from '@solus/contracts/integrations/command-line'
import { checkCommandDraft, commandDraftOf, commandHostNote, COMMAND_ADMIN_ONLY, parseEnvNames, type CommandDraftField } from '@solus/contracts/integrations/command-server'
import { usePalette } from '../../../theme/theme'
import { CODE_FONT, space, type } from '../../../theme/tokens'
import { Button, Field } from '../../../ui/primitives'
import { errorMessage } from '../integrations'
import { CommandValueFields } from './CommandValueFields'

/** What the add form hands over: the record to create and the values typed, or null when none. */
export interface CommandAdd {
  name: string
  launch: IntegrationLaunch
  envNames: string[]
  values: IntegrationEnvValue[] | null
}

/**
 * The add or edit form of a command (docs/plans/mcp-first-class.md §7.7): the
 * line with the program and arguments it gives, the working directory, the
 * environment variable names, and, when it adds, the name and the values. A
 * person without `host.admin` gets the reason in place of the form (§7.2). The
 * values live in this form only until Add sends them.
 */
export function CommandServerForm(props: {
  readonly hostName: string
  readonly mayRunCommands: boolean
  /** The command to edit; absent to add one. */
  readonly editing?: Integration
  readonly enabled: boolean
  /** The add form's Add and start. */
  readonly onAdd?: (add: CommandAdd) => Promise<void>
  /** The edit form's Save; `envNames` is absent when the names did not change. */
  readonly onEdit?: (launch: IntegrationLaunch, envNames: string[] | undefined) => Promise<void>
  readonly onCancel: () => void
}) {
  const palette = usePalette()
  const { editing } = props
  const savedNames = editing?.auth.kind === 'env' ? editing.auth.names : []
  const draft = editing?.launch ? commandDraftOf(editing.launch, savedNames) : null
  const [name, setName] = useState('')
  const [line, setLine] = useState(draft?.line ?? '')
  const [cwd, setCwd] = useState(draft?.cwd ?? '')
  const [envNames, setEnvNames] = useState(draft?.envNames ?? '')
  const [values, setValues] = useState<ReadonlyMap<string, string>>(new Map())
  const [problem, setProblem] = useState<CommandFormProblem | null>(null)
  const [saving, setSaving] = useState(false)

  if (!props.mayRunCommands) {
    return (
      <View style={{ gap: space.sm }}>
        <Text style={{ color: palette.textSecondary, fontSize: type.chrome }}>{COMMAND_ADMIN_ONLY}</Text>
        <Button label="Close" onPress={props.onCancel} />
      </View>
    )
  }

  const parsedNames = parseEnvNames(envNames)
  const names = parsedNames.ok ? parsedNames.names : []

  const save = () => {
    const check = checkCommandDraft({ name: editing ? undefined : name, line, cwd, envNames })
    if (!check.ok) return setProblem({ field: check.field, reason: check.reason })
    setProblem(null)
    const typed = names.map((each) => ({ name: each, value: values.get(each) ?? '' }))
    // The values leave this form in the call that saves them.
    setValues(new Map())
    setSaving(true)
    const namesChanged = check.envNames.join('\u0000') !== savedNames.join('\u0000')
    const run = editing
      ? props.onEdit?.(check.launch, namesChanged ? check.envNames : undefined)
      : props.onAdd?.({ name: check.name, launch: check.launch, envNames: check.envNames, values: typed.some((value) => value.value.length > 0) ? typed : null })
    void (run ?? Promise.resolve()).then(
      () => setSaving(false),
      (cause: unknown) => {
        setSaving(false)
        setProblem({ field: 'form', reason: errorMessage(cause) })
      },
    )
  }

  const editable = !saving && props.enabled
  return (
    <View style={{ gap: space.md }}>
      {editing ? null : <Field label="Name" placeholder="Filesystem" value={name} onChangeText={setName} editable={editable} returnKeyType="next" />}
      <View style={{ gap: space.xs }}>
        <Field label="Command" placeholder="npx -y @modelcontextprotocol/server-filesystem ~/notes" value={line} onChangeText={setLine} editable={editable} autoFocus returnKeyType="next" />
        <LinePreview line={line} problem={problem} />
      </View>
      <View style={{ gap: space.xs }}>
        <Field label="Working directory" placeholder="~" value={cwd} onChangeText={setCwd} editable={editable} returnKeyType="next" />
        <FieldNote problem={problem} field="cwd" text="Optional. A folder on the host; ~ is the home folder." />
      </View>
      <View style={{ gap: space.xs }}>
        <Field label="Environment variables" placeholder="GITHUB_TOKEN, API_URL" value={envNames} onChangeText={setEnvNames} editable={editable} returnKeyType="next" />
        <FieldNote problem={problem} field="envNames" text="Names only, separated by commas. Each value is a secret, saved for you alone and never shown again." />
      </View>
      {editing ? <FieldNote problem={null} field="form" text="Saving stops the command. New variable names remove the values saved for the old ones." /> : (
        <>
          {names.length > 0 ? <CommandValueFields names={names} values={values} onChange={setValues} editable={editable} /> : null}
          <FieldNote problem={null} field="form" text={commandHostNote(props.hostName)} />
        </>
      )}
      <FieldNote problem={problem} field="form" text="" />
      <Button tone="primary" label={editing ? 'Save' : 'Add and start'} busy={saving} disabled={!line.trim() || !props.enabled} onPress={save} />
      <Button label="Cancel" disabled={saving} onPress={props.onCancel} />
    </View>
  )
}

interface CommandFormProblem {
  field: CommandDraftField | 'form'
  reason: string
}

/** A field's hint, or the reason a save refused it. */
function FieldNote(props: { readonly problem: CommandFormProblem | null; readonly field: CommandFormProblem['field']; readonly text: string }) {
  const palette = usePalette()
  const reason = props.problem?.field === props.field ? props.problem.reason : null
  if (!reason && !props.text) return null
  return (
    <Text accessibilityRole={reason ? 'alert' : undefined} style={{ color: reason ? palette.danger : palette.textTertiary, fontSize: type.dense }}>{reason ?? props.text}</Text>
  )
}

/** What the host starts, word by word, while the line reads; why the line is refused, while it does not (§7.4). */
function LinePreview(props: { readonly line: string; readonly problem: CommandFormProblem | null }) {
  const palette = usePalette()
  const split = props.line.trim() ? splitCommandLine(props.line) : null
  if (split?.ok) {
    return <Text selectable style={{ color: palette.textSecondary, fontSize: type.dense, fontFamily: CODE_FONT }}>{`Starts ${[split.launch.command, ...split.launch.args].join(' · ')}`}</Text>
  }
  return <FieldNote problem={split ? { field: 'line', reason: split.reason } : props.problem} field="line" text="One program and its arguments. Solus starts it without a shell." />
}
