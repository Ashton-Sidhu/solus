import type { ReactNode } from 'react'
import { View } from 'react-native'
import type { KeyboardCommand } from './keyboard-commands'

/** Platforms with no native module: the app renders as is. iOS and Android
 *  use `KeyboardCommandsView.native.tsx`. */
export function KeyboardCommandsView({ children }: {
  enabledCommands: readonly KeyboardCommand[]
  onCommand: (command: KeyboardCommand) => void
  children: ReactNode
}) {
  return <View style={{ flex: 1 }}>{children}</View>
}
