import { View } from 'react-native'
import { space } from '../../../theme/tokens'
import { Field } from '../../../ui/primitives'

/**
 * One masked field for each environment variable name of a command
 * (docs/plans/mcp-first-class.md §7.7). A saved value is never shown; the
 * caller owns the drafts and clears them when it sends them.
 */
export function CommandValueFields(props: {
  readonly names: readonly string[]
  readonly values: ReadonlyMap<string, string>
  readonly onChange: (values: ReadonlyMap<string, string>) => void
  readonly editable: boolean
  readonly autoFocus?: boolean
}) {
  return (
    <View style={{ gap: space.sm }}>
      {props.names.map((name, index) => (
        <Field
          key={name}
          label={name}
          placeholder="Value"
          value={props.values.get(name) ?? ''}
          onChangeText={(text) => props.onChange(new Map(props.values).set(name, text))}
          secureTextEntry
          textContentType="password"
          editable={props.editable}
          autoFocus={props.autoFocus === true && index === 0}
          returnKeyType={index === props.names.length - 1 ? 'done' : 'next'}
        />
      ))}
    </View>
  )
}
