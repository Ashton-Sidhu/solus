import type { ReactNode } from 'react'
import { View } from 'react-native'
import type { KeyboardCommand } from './keyboard-commands'

/** Android and other platforms: no hardware command surface yet, so the app
 *  renders as is. iOS uses `KeyboardCommandsView.ios.tsx`. */
export function KeyboardCommandsView({ children }: {
  enabledCommands: readonly KeyboardCommand[]
  onCommand: (command: KeyboardCommand) => void
  children: ReactNode
}) {
  return <View style={{ flex: 1 }}>{children}</View>
}
