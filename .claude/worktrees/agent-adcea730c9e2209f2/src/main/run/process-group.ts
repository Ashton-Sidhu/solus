export function stopProcessGroup(pid: number, force: boolean): void {
  process.kill(-pid, 'SIGTERM')
  if (force) {
    // The app is about to quit, so no delayed escalation can be relied on.
    try { process.kill(-pid, 'SIGKILL') } catch {}
    return
  }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch {}
  }, 5_000)
}
