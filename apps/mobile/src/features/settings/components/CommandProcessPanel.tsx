import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import type { CommandProcessActionKind, CommandProcessStatus } from '@solus/contracts/integrations/command-server'
import { usePalette } from '../../../theme/theme'
import { CODE_FONT, space, type } from '../../../theme/tokens'
import { Button } from '../../../ui/primitives'

/**
 * The person's process of one command (docs/plans/mcp-first-class.md §7.7):
 * the state in words, what the host said, the last standard error, and the
 * actions that change it. Stop and Cancel stay on for a person without
 * `host.admin`; the actions that start the command say why they are off.
 */
export function CommandProcessPanel(props: {
  /** From `commandProcessStatus`, the rule every client shares. */
  readonly status: CommandProcessStatus
  readonly error: string | undefined
  readonly enabled: boolean
  readonly onAction: (kind: CommandProcessActionKind) => void
}) {
  const palette = usePalette()
  const [stderrOpen, setStderrOpen] = useState(false)
  const { status } = props
  const color = status.tone === 'error' ? palette.danger : status.tone === 'ready' ? palette.text : palette.textSecondary
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {status.state === 'starting' ? <ActivityIndicator size="small" /> : null}
        <Text accessibilityRole="text" style={{ color, fontSize: type.chrome, fontWeight: '600' }}>{status.label}</Text>
      </View>
      {status.detail ? <Text selectable style={{ color: palette.textSecondary, fontSize: type.chrome }}>{status.detail}</Text> : null}
      {props.error ? <Text accessibilityRole="alert" selectable style={{ color: palette.danger, fontSize: type.chrome }}>{props.error}</Text> : null}
      {status.stderrTail ? (
        <View style={{ gap: space.xs }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Standard error" accessibilityState={{ expanded: stderrOpen }} onPress={() => setStderrOpen((open) => !open)}>
            <Text style={{ color: palette.textSecondary, fontSize: type.dense }}>{`Standard error ${stderrOpen ? '−' : '+'}`}</Text>
          </Pressable>
          {stderrOpen ? <Text selectable style={{ color: palette.text, fontSize: type.dense, fontFamily: CODE_FONT }}>{status.stderrTail}</Text> : null}
        </View>
      ) : null}
      {status.actions.map((action, index) => (
        <Button key={action.kind} tone={index === 0 ? 'secondary' : 'plain'} label={action.label} disabled={!action.isEnabled || !props.enabled} onPress={() => props.onAction(action.kind)} />
      ))}
      {status.blockedReason ? <Text style={{ color: palette.textTertiary, fontSize: type.dense }}>{status.blockedReason}</Text> : null}
    </View>
  )
}
