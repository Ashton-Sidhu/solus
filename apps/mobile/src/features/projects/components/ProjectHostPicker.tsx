import { Platform } from 'react-native'
import { SymbolView } from '../../../components/AppSymbol'
import { EnvironmentMachineSymbol } from '../../../components/EnvironmentMachineSymbol'
import { useProjectHosts } from '../use-project-hosts'
import { LIST_ROW_ICON_SIZE, ListRow, ListSection } from './add-project-ui'

/** The machine rows T3 shows in Add Project and New Project. */
export function ProjectHostPicker(props: { readonly hostId: string; readonly disabled?: boolean; readonly onSelect: (hostId: string) => void }) {
  const { choices } = useProjectHosts()
  if (choices.length < 2 && choices.every((host) => host.ready)) return null
  return (
    <ListSection>
      {choices.map((host, index) => (
        <ListRow key={host.id} title={host.label} subtitle={host.detail} selected={host.id === props.hostId}
          isFirst={index === 0} disabled={props.disabled || !host.ready}
          icon={<EnvironmentMachineSymbol kind={host.machine} size={LIST_ROW_ICON_SIZE} tintColorClassName="accent-icon" />}
          right={host.id === props.hostId ? <SymbolView name="checkmark" size={Platform.OS === 'android' ? 20 : 14} tintColorClassName="accent-icon" type="monochrome" /> : null}
          onPress={() => props.onSelect(host.id)} />
      ))}
    </ListSection>
  )
}
