// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestAction.ts (MIT, see UPSTREAM.md).
import { useRef, useState } from 'react'
import { Alert } from 'react-native'
import { useApp, useListened } from '../../../app/app-context'
import type { PullRequestRef } from '../pull-request-directory'

/**
 * Runs a write on a pull request from a row, so the row and the scroll
 * position stay where they are. One write at a time; a failure shows its
 * reason. The store reads the pull request again after each write.
 */
export function usePullRequestAction(ref: PullRequestRef) {
  const app = useApp()
  const running = useListened(app.pullRequestActions.changes, () => app.pullRequestActions.runningOf(ref))
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const perform = async <Result>(failureTitle: string, write: () => Promise<Result>): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so catch and finally see both.
    return await (async () => {
      await write()
      return true
    })().catch((cause) => {
      Alert.alert(failureTitle, cause instanceof Error ? cause.message : 'Try again.')
      return false
    }).finally(() => {
      pending.current = false
      setBusy(false)
    })
  }
  /** Asks first; `destructive` paints the confirm button red. */
  const confirm = <Result>(title: string, message: string, confirmText: string, write: () => Promise<Result>, destructive = false) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => void perform(`Could not ${confirmText.toLowerCase()}`, write) },
    ])
  }
  return { busy: busy || running !== null, running, perform, confirm }
}
