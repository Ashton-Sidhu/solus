/**
 * Apps outside Solus that use a host's tools over MCP (plans/035 §10), as a
 * person picks one to connect and as an organization allows them.
 *
 * An app is known by where its sign-in returns: the host of its OAuth redirect
 * address, or its scheme. An app on the person's own computer (Claude Code,
 * Codex, and any other CLI) returns to `localhost` and is `local`; one Solus
 * cannot name is `other`. A policy allows apps by these ids (`sessions.limits.apps`).
 */
export const OUTSIDE_APP_IDS = ['claude', 'chatgpt', 'grok-bot', 'poke', 'muse', 'instinct', 'cursor', 'local', 'other'] as const
export type OutsideAppId = (typeof OUTSIDE_APP_IDS)[number]

/** What a person reads for each id, in a policy editor and a refusal. */
export const OUTSIDE_APP_NAMES = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  'grok-bot': 'Grok Bot',
  poke: 'Poke',
  muse: 'Muse',
  instinct: 'Instinct',
  cursor: 'Cursor',
  local: 'Apps on your computer (Claude Code, Codex, OpenClaw, Hermes Agent)',
  other: 'Other apps',
} as const satisfies Record<OutsideAppId, string>

/** Where each known app's sign-in returns. A host matches itself and its subdomains. */
const REDIRECTS: ReadonlyArray<{ app: OutsideAppId; hosts?: readonly string[]; schemes?: readonly string[] }> = [
  { app: 'claude', hosts: ['claude.ai', 'claude.com'] },
  { app: 'chatgpt', hosts: ['chatgpt.com', 'openai.com'] },
  { app: 'grok-bot', hosts: ['x.ai', 'grok.com'] },
  { app: 'poke', hosts: ['poke.com'] },
  // Meta's personal agent. Its sign-in returns to https://agent.meta.ai/api/hatch/oauth/callback,
  // as connector guides report (docs.nansen.ai/mcp/connectors/muse, apptoto.com, koala73/worldmonitor#9527).
  // Only `agent.meta.ai`, not all of meta.ai, which other Meta products use.
  { app: 'muse', hosts: ['agent.meta.ai', 'muse.ai'] },
  // Instinct publishes no redirect address. Only Instinct controls instinct.com, so a
  // sign-in that returns there or to a subdomain is Instinct's.
  { app: 'instinct', hosts: ['instinct.com'] },
  { app: 'cursor', schemes: ['cursor:'] },
]

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A URL's hostname that names the computer it is read on. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

function appOfRedirect(uri: string): OutsideAppId {
  if (!URL.canParse(uri)) return 'other'
  const url = new URL(uri)
  if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname)) return 'local'
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
  /** The guide's id; Claude Code, Codex, OpenClaw, and Hermes Agent are separate guides for the one id `local`. */
  id: string
  name: string
  app: OutsideAppId
  handoff: OutsideAppHandoff
  /** The steps to set it up another way, next to the address. */
  steps: readonly string[]
  /** The app runs in a browser or a cloud service: it needs the host's public address. */
  needsPublicUrl: boolean
  /** One line under the primary action, about a limit or a step the person may meet. */
  note?: string
  docs?: string
}

const encoded = encodeURIComponent

/**
 * Cursor's MCP install link (cursor.com/docs/context/mcp/install-links): Cursor
 * asks to install Solus with this address. The config is base64 of its JSON,
 * made with `btoa`, which browsers, the server, and React Native all have.
 */
function cursorInstallLink(mcpUrl: string): string {
  const config = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ url: mcpUrl }))))
  return `cursor://anysphere.cursor-deeplink/mcp/install?${new URLSearchParams({ name: 'Solus', config })}`
}

export const OUTSIDE_APP_GUIDES: readonly OutsideAppGuide[] = [
  {
    id: 'claude',
    name: 'Claude',
    app: 'claude',
    handoff: { kind: 'open', link: (url) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Solus&connectorUrl=${encoded(url)}` },
    steps: ['In Claude, open Customize, then Connectors.', 'Choose Add custom connector and paste the address.'],
    needsPublicUrl: true,
    note: 'The Free plan allows one custom connector.',
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
    note: 'Shared with all your Grok Bots.',
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
    id: 'muse',
    name: 'Muse',
    app: 'muse',
    handoff: { kind: 'copy-message', link: 'https://muse.ai', message: (url) => `Create a custom connector for the MCP server ${url}.` },
    steps: ['Send this message to Muse.'],
    needsPublicUrl: true,
    docs: 'https://www.meta.com/help/artificial-intelligence/1687253048996149/',
  },
  {
    id: 'instinct',
    name: 'Instinct',
    app: 'instinct',
    handoff: { kind: 'copy-message', link: 'https://app.instinct.com', message: (url) => `Connect the MCP server ${url}.` },
    steps: ['In Instinct, open Settings, then MCP connections, if your account has it.'],
    needsPublicUrl: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    app: 'cursor',
    handoff: { kind: 'open', link: cursorInstallLink },
    steps: ['Cursor asks to install Solus. Choose Install.', 'Cursor then opens the sign-in page.'],
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
  {
    id: 'openclaw',
    name: 'OpenClaw',
    app: 'local',
    handoff: {
      kind: 'commands',
      commands: (url) => [
        // Its MCP commands refuse to write while the Gateway runs.
        'openclaw gateway stop',
        `openclaw mcp add solus --url ${url} --transport streamable-http --auth oauth`,
        'openclaw mcp login solus',
        'openclaw gateway start',
      ],
    },
    steps: [
      'Open the Control UI, then + and Plugins, and choose Add MCP server.',
      'Paste the address, and choose Streamable HTTP and OAuth.',
      'Select Sign in for it under Settings → MCP.',
    ],
    needsPublicUrl: false,
    docs: 'https://docs.openclaw.ai/tools/mcp',
  },
  {
    id: 'hermes-agent',
    name: 'Hermes Agent',
    app: 'local',
    handoff: {
      kind: 'commands',
      // `add` signs in on its first connection (30 s by default, too short to get a
      // code); `login` would clear that sign-in and need a second code.
      commands: (url) => [`hermes mcp add solus --url ${url} --auth oauth --connect-timeout 315`],
    },
    steps: [
      'Add solus under mcp_servers in ~/.hermes/config.yaml, with the address and auth: oauth.',
      'Run hermes mcp login solus.',
    ],
    needsPublicUrl: false,
    note: 'On a remote host, paste the final address back when asked.',
    docs: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
  },
]

/**
 * The link that opens an app's waiting sign-in in a Solus client: the phone app
 * takes it from the sign-in page's QR code (plans/035 §0.5). `hostId` is the
 * host's installation id, so the client calls the host that holds the sign-in.
 */
export function appSignInLink(hostId: string, requestId: string): string {
  return `solus://approve-app?${new URLSearchParams({ host: hostId, request: requestId })}`
}

/** The host and sign-in an `appSignInLink` names, or null for any other link. */
export function parseAppSignInLink(link: string): { hostId: string; requestId: string } | null {
  if (!URL.canParse(link)) return null
  const url = new URL(link)
  if (url.protocol !== 'solus:' || url.host !== 'approve-app') return null
  const hostId = url.searchParams.get('host')
  const requestId = url.searchParams.get('request')
  return hostId && requestId ? { hostId, requestId } : null
}
