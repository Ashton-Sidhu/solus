/**
 * The `solus` command that comes with the desktop app runs this CLI through the
 * app's own executable (docs/plans/windows.md §5.12); its launcher sets
 * `SOLUS_DESKTOP_CLI=1`. The desktop's server is the app, so only the commands
 * that talk to a running server apply. The others install, start, and update a
 * standalone server, which has its own `solus`.
 */
const DESKTOP_COMMANDS = new Set(['pair', 'connect'])

export function isDesktopCli(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOLUS_DESKTOP_CLI === '1'
}

/** Why the desktop's `solus` will not run `command`, or null when it will. */
export function desktopRefusal(command: string): string | null {
  if (DESKTOP_COMMANDS.has(command)) return null
  return `\`solus ${command}\` manages a standalone Solus server. This \`solus\` comes with the desktop app, whose server is the app itself; it runs \`solus pair\` and \`solus connect\`. To run a standalone server, install it with the install script in the README: https://github.com/Ashton-Sidhu/solus#readme`
}

export const DESKTOP_USAGE = `Usage (the solus command of the desktop app):
  solus pair
  solus connect [--code CODE] [--cloud-url URL] [--no-open]
  solus connect status [--json]
  solus connect remove ORGANIZATION_ID
  solus connect unlink
  solus --version
  solus --help`
