export const SSH_CONNECT_TIMEOUT_SECONDS = 10

export function sshConnectionOptions(batchMode = true): string[] {
  return [
    '-o', `BatchMode=${batchMode ? 'yes' : 'no'}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
  ]
}
