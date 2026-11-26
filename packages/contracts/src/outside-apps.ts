/**
 * Apps outside Solus that use a host's tools over MCP (plans/035 §10), as a
 * person picks one to connect and as an organization allows them.
 *
 * An app is known by where its sign-in returns: the host of its OAuth redirect
 * address, or its scheme. An app on the person's own computer (Claude Code,
 * Codex, and any other CLI) returns to `localhost` and is `local`; one Solus
 * cannot name is `other`. A policy allows apps by these ids (`sessions.limits.apps`).
 */
export const OUTSIDE_APP_IDS = ['claude', 'chatgpt', 'grok-bot', 'poke', 'cursor', 'local', 'other'] as const
export type OutsideAppId = (typeof OUTSIDE_APP_IDS)[number]

/** What a person reads for each id, in a policy editor and a refusal. */
export const OUTSIDE_APP_NAMES = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  'grok-bot': 'Grok Bot',
  poke: 'Poke',
  cursor: 'Cursor',
  local: 'Apps on your computer (Claude Code, Codex)',
  other: 'Other apps',
} as const satisfies Record<OutsideAppId, string>

/** Where each known app's sign-in returns. A host matches itself and its subdomains. */
const REDIRECTS: ReadonlyArray<{ app: OutsideAppId; hosts?: readonly string[]; schemes?: readonly string[] }> = [
  { app: 'claude', hosts: ['claude.ai', 'claude.com'] },
  { app: 'chatgpt', hosts: ['chatgpt.com', 'openai.com'] },
  { app: 'grok-bot', hosts: ['x.ai', 'grok.com'] },
  { app: 'poke', hosts: ['poke.com'] },
  { app: 'cursor', schemes: ['cursor:'] },
]

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

function appOfRedirect(uri: string): OutsideAppId {
  if (!URL.canParse(uri)) return 'other'
  const url = new URL(uri)
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)) return 'local'
  const known = REDIRECTS.find((entry) =>
    entry.schemes?.includes(url.protocol)
    || entry.hosts?.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))
  return known?.app ?? 'other'
}

/** The app a sign-in comes from. A client whose redirect addresses name different apps is `other`. */
export function outsideAppOf(redirectUris: readonly string[]): OutsideAppId {
  const apps = new Set(redirectUris.map(appOfRedirect))
  const [only] = apps
  return apps.size === 1 && only ? only : 'other'
}

/** How a person hands the host's MCP address to an app. */
export type OutsideAppHandoff =
  /** Opens the app's add form with Solus filled in. */
  | { kind: 'open'; link: (mcpUrl: string) => string }
  /** Copies the address, then opens the page it goes on. */
  | { kind: 'copy-url'; link: string }
  /** Copies a message for the app's chat, then opens the app. */
  | { kind: 'copy-message'; link: string; appLink?: (message: string) => string; message: (mcpUrl: string) => string }
  /** Commands to run where the app runs. */
  | { kind: 'commands'; commands: (mcpUrl: string) => readonly string[] }

/** One app a person can pick to connect, with how to set it up. */
export interface OutsideAppGuide {
  /** The guide's id; Claude Code and Codex are separate guides for the one id `local`. */
  id: string
  name: string
  app: OutsideAppId
  handoff: OutsideAppHandoff
  /** The steps to set it up another way, next to the address. */
  steps: readonly string[]
  /** The app runs in a browser or a cloud service: it needs the host's public address. */
  needsPublicUrl: boolean
  docs?: string
}

const encoded = encodeURIComponent

export const OUTSIDE_APP_GUIDES: readonly OutsideAppGuide[] = [
  {
    id: 'claude',
    name: 'Claude',
    app: 'claude',
    handoff: { kind: 'open', link: (url) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Solus&connectorUrl=${encoded(url)}` },
    steps: ['In Claude, open Customize, then Connectors.', 'Choose Add custom connector and paste the address.'],
    needsPublicUrl: true,
    docs: 'https://claude.com/docs/connectors/building/directory-vs-custom',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    app: 'chatgpt',
    handoff: { kind: 'copy-url', link: 'https://chatgpt.com/plugins' },
    steps: ['Open chatgpt.com/plugins, then + and Add custom MCP server.', 'Paste the address. Choose OAuth.'],
    needsPublicUrl: true,
    docs: 'https://developers.openai.com/api/docs/guides/custom-mcp-server',
  },
  {
    id: 'grok-bot',
    name: 'Grok Bot',
    app: 'grok-bot',
    handoff: {
      kind: 'copy-message',
      link: 'https://x.ai/bot',
      appLink: (message) => `grokbot://app/v1/prompt?text=${encoded(message)}`,
      message: (url) => `Add the MCP server ${url} and connect it.`,
    },
    steps: ['Send this message to any of your Grok Bots.'],
    needsPublicUrl: true,
    docs: 'https://docs.x.ai/grok-bot/computer-and-apps',
  },
  {
    id: 'poke',
    name: 'Poke',
    app: 'poke',
    handoff: { kind: 'open', link: (url) => `https://poke.com/integrations/new?name=Solus&url=${encoded(url)}` },
    steps: ['Open poke.com/integrations/new.', 'Paste the address and add the integration.'],
    needsPublicUrl: true,
    docs: 'https://poke.com/docs/mcp-servers',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    app: 'cursor',
    handoff: { kind: 'copy-url', link: 'cursor://anysphere.cursor-deeplink/settings/mcp' },
    steps: ['In Cursor, open Settings, then MCP.', 'Add a server with the address. Cursor opens the sign-in page.'],
    needsPublicUrl: false,
    docs: 'https://docs.cursor.com/context/model-context-protocol',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    app: 'local',
    handoff: { kind: 'commands', commands: (url) => [`claude mcp add --transport http solus ${url}`, 'claude mcp login solus'] },
    steps: ['Run these commands where Claude Code runs.'],
    needsPublicUrl: false,
  },
  {
    id: 'codex',
    name: 'Codex',
    app: 'local',
    handoff: { kind: 'commands', commands: (url) => [`codex mcp add solus --url ${url}`, 'codex mcp login solus'] },
    steps: ['Run these commands where Codex runs.'],
    needsPublicUrl: false,
  },
]
