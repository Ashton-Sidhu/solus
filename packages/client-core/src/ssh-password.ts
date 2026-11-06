/** Why a client does not send a password on this connection (docs/plans/ssh-forward-password.md D5). */
export function unencryptedPasswordMessage(hostLabel: string): string {
  return `The connection to ${hostLabel} is not encrypted, so Solus does not send a password over it. Connect to ${hostLabel} through your account or a tailnet, or use that computer.`
}
