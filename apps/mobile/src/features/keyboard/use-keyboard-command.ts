import { useEffect, useRef } from 'react'
import { useApp } from '../../app/app-context'
import type { KeyboardCommand, KeyboardCommandHandler } from './keyboard-commands'

/** Handles one keyboard command while the component is mounted and `enabled`. */
export function useKeyboardCommand(command: KeyboardCommand, handler: KeyboardCommandHandler, enabled = true): void {
  const app = useApp()
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!enabled) return
    return app.keyboard.register(command, () => latest.current())
  }, [app, command, enabled])
}
