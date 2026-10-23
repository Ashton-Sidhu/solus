import type {
  CatalogEntry,
  Integration,
  IntegrationConnection,
  IntegrationToolSummary,
} from '@solus/contracts/integration-types'

// MCP servers for the demo's MCP settings page.
//
// The real page reads the host's installed servers, the person's sign-ins, and
// the integrations.sh catalog. The demo has none of them, so it serves the
// servers an acme engineer would have connected for the rate-limiting work —
// the code host, the trackers, the docs, the errors, the chat — and a catalog
// of the servers they could add next. Names, addresses, and descriptions are
// the integrations.sh feed's own.

const AT = '2026-10-21T16:42:00.000Z'
const ACCOUNT = 'dev@acme.dev'

interface DemoServerSeed {
  slug: string
  name: string
  url: string
  /** `none`: the server needs no sign-in, so it is ready as soon as it is added. */
  auth: 'oauth' | 'none'
  /** The account the server reported at sign-in. */
  account?: string
  tools: Array<[name: string, description: string, readOnly: boolean]>
}

const INSTALLED: DemoServerSeed[] = [
  {
    slug: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'oauth', account: 'acme-dev',
    tools: [
      ['search_issues', 'Search issues and pull requests across repositories.', true],
      ['get_pull_request', 'Read a pull request with its files, reviews, and checks.', true],
      ['create_pull_request', 'Open a pull request from a branch.', false],
      ['add_issue_comment', 'Comment on an issue or pull request.', false],
    ],
  },
  {
    slug: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', account: ACCOUNT,
    tools: [
      ['list_issues', 'List issues by team, project, assignee, or state.', true],
      ['get_issue', 'Read one issue with its comments.', true],
      ['update_issue', 'Change an issue’s state, assignee, or estimate.', false],
    ],
  },
  {
    slug: 'atlassian', name: 'Atlassian Rovo', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth', account: ACCOUNT,
    tools: [
      ['searchJiraIssuesUsingJql', 'Search Jira issues with JQL.', true],
      ['getConfluencePage', 'Read a Confluence page.', true],
      ['transitionJiraIssue', 'Move a Jira issue to another status.', false],
    ],
  },
  {
    slug: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', account: 'Acme Dev',
    tools: [
      ['search', 'Search pages and databases in the workspace.', true],
      ['fetch', 'Read a page or database by its address.', true],
      ['create-pages', 'Create pages under a parent page.', false],
    ],
  },
  {
    slug: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', account: ACCOUNT,
    tools: [
      ['search_issues', 'Find issues by project, release, or query.', true],
      ['get_issue_details', 'Read an issue with its latest event and stack trace.', true],
      ['analyze_issue_with_seer', 'Ask Seer for the root cause of an issue.', true],
      ['update_issue', 'Resolve, ignore, or assign an issue.', false],
    ],
  },
  {
    slug: 'slack', name: 'Slack', url: 'https://mcp.slack.com/mcp', auth: 'oauth', account: ACCOUNT,
    tools: [
      ['search_messages', 'Search messages in the channels you can read.', true],
      ['read_thread', 'Read a thread with its replies.', true],
      ['send_message', 'Post a message to a channel or thread.', false],
    ],
  },
  {
    slug: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', auth: 'none',
    tools: [
      ['resolve-library-id', 'Find the Context7 id of a library.', true],
      ['get-library-docs', 'Fetch current documentation and examples for a library.', true],
    ],
  },
]

export const DEMO_INTEGRATIONS: Integration[] = INSTALLED.map((server) => ({
  id: `demo-mcp-${server.slug}`,
  organizationId: 'local',
  ownerKey: 'local:demo',
  kind: 'mcp',
  slug: server.slug,
  name: server.name,
  url: server.url,
  auth: server.auth === 'none'
    ? { kind: 'none' }
    : { kind: 'oauth', discover: `${new URL(server.url).origin}/.well-known/oauth-protected-resource`, registration: 'dynamic' },
  disabledTools: [],
  createdBy: 'demo',
  createdAt: AT,
  updatedAt: AT,
  role: 'owner',
}))

export const DEMO_INTEGRATION_CONNECTIONS: IntegrationConnection[] = INSTALLED
  .filter((server) => server.auth === 'oauth')
  .map((server) => ({
    integrationId: `demo-mcp-${server.slug}`,
    accountId: 'default',
    status: 'connected',
    source: 'host',
    label: null,
    info: server.account ? { displayName: server.account } : null,
    error: null,
    updatedAt: AT,
  }))

export const DEMO_INTEGRATION_TOOLS = new Map<string, IntegrationToolSummary[]>(
  INSTALLED.map((server) => [
    `demo-mcp-${server.slug}`,
    server.tools.map(([name, description, readOnly]) => ({ name, description, readOnly, destructive: false })),
  ]),
)

type CatalogSeed = [slug: string, name: string, url: string, domain: string, categories: string[], description: string]

/** In popularity order, as the feed ranks the page. The installed servers are
 *  in it too, where the catalog marks them Connected. */
const CATALOG: CatalogSeed[] = [
  ['github', 'GitHub', 'https://api.githubcopilot.com/mcp/', 'github.com', ['developer-tools', 'version-control'], 'Issues, pull requests, code search, and Actions through GitHub’s official remote MCP server.'],
  ['figma', 'Figma', 'https://mcp.figma.com/mcp', 'figma.com', ['design', 'collaboration'], 'Inspect frames, components, and variables, and turn designs into code context.'],
  ['linear', 'Linear', 'https://mcp.linear.app/mcp', 'linear.app', ['productivity', 'project-management'], 'Find, create, and update issues, projects, and comments in Linear.'],
  ['vercel', 'Vercel', 'https://mcp.vercel.com', 'vercel.com', ['hosting', 'developer-tools'], 'Search the docs, manage projects, and read deployment logs on Vercel.'],
  ['atlassian', 'Atlassian Rovo', 'https://mcp.atlassian.com/v1/mcp', 'atlassian.com', ['productivity'], 'Permission-aware access to Jira and Confluence: search, summarize, and update issues and pages.'],
  ['supabase', 'Supabase', 'https://mcp.supabase.com/mcp', 'supabase.com', ['code', 'data'], 'Run SQL on Postgres, manage tables and migrations, and read project logs.'],
  ['notion', 'Notion', 'https://mcp.notion.com/mcp', 'notion.com', ['productivity', 'knowledge-base'], 'Search, create, and reorganize pages and databases in your Notion workspace.'],
  ['neon', 'Neon', 'https://mcp.neon.tech/mcp', 'neon.com', ['database', 'devtools'], 'Manage serverless Postgres projects and branches, and run queries against them.'],
  ['sentry', 'Sentry', 'https://mcp.sentry.dev/mcp', 'sentry.io', ['observability', 'developer-tools'], 'Issues, events, releases, and Seer root-cause analysis from Sentry.'],
  ['posthog', 'PostHog', 'https://mcp.posthog.com/mcp', 'posthog.com', ['analytics', 'developer-tools'], 'Run HogQL, build insights and dashboards, and manage feature flags.'],
  ['slack', 'Slack', 'https://mcp.slack.com/mcp', 'slack.com', ['communication', 'productivity'], 'Search messages, read threads, and post to channels in Slack.'],
  ['stripe', 'Stripe', 'https://mcp.stripe.com', 'stripe.com', ['payments', 'financial-services'], 'Search Stripe’s documentation and work with customers, products, and payments.'],
  ['context7', 'Context7', 'https://mcp.context7.com/mcp', 'context7.com', ['code'], 'Up-to-date code examples and documentation for the libraries you use.'],
  ['cloudflare', 'Cloudflare Developer Platform', 'https://bindings.mcp.cloudflare.com/mcp', 'cloudflare.com', ['code'], 'Build on Workers with KV, R2, D1, and AI bindings.'],
  ['pagerduty', 'PagerDuty', 'https://mcp.pagerduty.com/mcp', 'pagerduty.com', ['code'], 'Manage incidents, services, schedule overrides, and on-call rotations.'],
  ['honeycomb', 'Honeycomb', 'https://mcp.honeycomb.io/mcp', 'honeycomb.io', ['data'], 'Query and explore OpenTelemetry traces and events in Honeycomb.'],
  ['asana', 'Asana', 'https://mcp.asana.com/v2/mcp', 'asana.com', ['productivity', 'communication'], 'Search, create, update, and track tasks, projects, and goals in Asana.'],
  ['postman', 'Postman', 'https://mcp.postman.com/minimal', 'postman.com', ['code'], 'Automate work across Postman collections, environments, and workspaces.'],
  ['mixpanel', 'Mixpanel', 'https://mcp.mixpanel.com/mcp', 'mixpanel.com', ['data'], 'Run segmentation, funnel, and retention analyses on your Mixpanel data.'],
  ['canva', 'Canva', 'https://mcp.canva.com/mcp', 'canva.com', ['design'], 'Browse, summarize, autofill, and generate Canva designs.'],
]

export const DEMO_CATALOG: CatalogEntry[] = [
  ...CATALOG.map(([slug, name, url, domain, categories, description], index): CatalogEntry => ({
    id: slug,
    kind: 'mcp',
    slug,
    name,
    description,
    domain,
    icon: `https://integrations.sh/logo/${domain}`,
    categories,
    popularity: CATALOG.length - index,
    url,
  })),
  // A server Solus writes and runs inside the host, listed beside the feed's (§13.6).
  {
    id: 'solus:google-drive',
    kind: 'solus',
    slug: 'google-drive',
    name: 'Google Drive',
    description: 'Search, read, and create files in your Google Drive.',
    domain: 'drive.google.com',
    icon: 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
    categories: ['productivity'],
    popularity: null,
    url: 'solus:google-drive',
    source: 'solus',
  },
]
