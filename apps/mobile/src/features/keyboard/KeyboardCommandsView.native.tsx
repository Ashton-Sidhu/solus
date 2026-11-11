import type { ReactNode } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import { requireNativeView } from 'expo'
import { KEYBOARD_COMMANDS, type KeyboardCommand } from './keyboard-commands'

interface NativeProps extends ViewProps {
  enabledCommands: readonly KeyboardCommand[]
  onCommand: (event: NativeSyntheticEvent<{ command: string }>) => void
}

const NativeKeyboardCommands = requireNativeView<NativeProps>('SolusKeyboardCommands')

/** Wraps the app so the key commands work while the composer is focused:
 *  on iOS UIKit finds them in the responder chain; on Android the view sees
 *  hardware Return before the focused text input. */
export function KeyboardCommandsView({ enabledCommands, onCommand, children }: {
  enabledCommands: readonly KeyboardCommand[]
  onCommand: (command: KeyboardCommand) => void
  children: ReactNode
}) {
  return (
    <NativeKeyboardCommands
      enabledCommands={enabledCommands}
      onCommand={(event) => {
        const command = KEYBOARD_COMMANDS.find((candidate) => candidate === event.nativeEvent.command)
        if (command) onCommand(command)
      }}
      style={{ flex: 1 }}
    >
      {children}
    </NativeKeyboardCommands>
  )
}
