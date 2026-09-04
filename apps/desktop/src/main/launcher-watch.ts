interface LauncherWatchOptions {
  launcherPid: number
  readParentPid(): number
  onLauncherGone(): void
  intervalMs?: number
}

/**
 * electron-vite starts the dev app with inherited stdio and no IPC channel, so
 * nothing tells this process when its launcher dies. Ctrl+C reaches the whole
 * terminal process group, but `kill <pid>` on the launcher leaves Electron
 * orphaned under launchd with its windows still open. Poll the parent pid and
 * report once, when it changes.
 */
export function watchLauncher(options: LauncherWatchOptions): () => void {
  const timer = setInterval(() => {
    if (options.readParentPid() === options.launcherPid) return
    clearInterval(timer)
    options.onLauncherGone()
  }, options.intervalMs ?? 1_000)
  timer.unref()
  return () => clearInterval(timer)
}
