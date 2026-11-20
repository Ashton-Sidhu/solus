import type {
  CatalogEntry,
  Integration,
  IntegrationConnection,
  IntegrationFacts,
  IntegrationToolSummary,
} from '@solus/contracts/integration-types'
import type { IntegrationPromptList } from '@solus/contracts/integrations/prompts'

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

// Cut at the length the gateway keeps for one server (2,000 characters), so the page shows the longest text it can get.
const CONTEXT7_INSTRUCTIONS = [
  'Context7 gives current documentation and code examples for libraries and frameworks.',
  '',
  'Always call resolve-library-id first to get the Context7 id of a library, unless the user gives an id in the form /org/project or /org/project/version. Do not guess an id.',
  '',
  'Then call get-library-docs with that id. Use the topic parameter to focus the reply on one subject, for example, "routing" or "hooks". Use the tokens parameter to limit the size of the reply; the default is 10,000 tokens.',
  '',
  'When the user names a version, give the id with that version. When the user names no version, use the latest version and say which version the documentation is for.',
  '',
  'Prefer this documentation to what you remember. Libraries change, and examples from memory can use names that no longer exist. When the documentation and your memory disagree, follow the documentation and tell the user.',
  '',
  'Rules:',
  '- Call resolve-library-id once for each library in a task, then keep the id.',
  '- Do not call get-library-docs for the standard library of a language.',
  '- If resolve-library-id gives more than one match, choose the one with the most code snippets and the highest trust score, and tell the user which one you chose.',
  '- If no match is found, tell the user and continue without Context7.',
  '- Quote code from the documentation as it is. Do not change names or signatures.',
  '- Keep each reply to the part of the documentation that the task needs. Do not paste a full page into the conversation.',
  '- When a library has a migration guide for the version in use, read it before you change code that calls the library.',
  '- Do not send secrets, tokens, or private code to Context7. Send only library names and topics.',
  '',
  'Limits: each account can make 60 requests in one minute. When a request is refused for this reason, wait and then try again once.',
  '',
  'Libraries that Context7 does not index yet can be added at context7.com. Tell the user when a library is missing, so that they can add it, and then continue with the documentation in the repository.',
].join('\n').slice(0, 2000)

interface DemoServerSeed {
  slug: string
  name: string
  url: string
  /** `none`: the server needs no sign-in, so it is ready as soon as it is added. */
  auth: 'oauth' | 'none'
  /** The account the server reported at sign-in. */
  account?: string
  tools: Array<[name: string, description: string, readOnly: boolean]>
  /** What the server tells the agent about its tools, as its `initialize` reply gives it. */
  instructions?: string
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
    instructions: 'Use search_issues before get_issue_details. Give the organization slug "acme" in every call.',
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
    instructions: CONTEXT7_INSTRUCTIONS,
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

export const DEMO_INTEGRATION_FACTS = new Map<string, IntegrationFacts>(
  INSTALLED.map((server) => [
    `demo-mcp-${server.slug}`,
    { era: 'modern', instructions: server.instructions ?? null, capabilities: { prompts: false, resources: false, resourceSubscribe: false, tasks: false } },
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

/** The MCP prompts the demo's servers list (docs/plans/mcp-first-class.md §10): two servers, and one that waits on a sign-in. */
export const DEMO_INTEGRATION_PROMPTS: IntegrationPromptList = {
  prompts: [
    {
      integrationId: 'demo-mcp-github', integrationName: 'GitHub', command: '/github:review_pr', name: 'review_pr',
      title: 'Review a pull request', description: 'Review one pull request against the repository rules.',
      arguments: [
        { name: 'number', description: 'The pull request number', required: true },
        { name: 'focus', description: 'What to look at first, such as tests', required: false },
      ],
    },
    {
      integrationId: 'demo-mcp-github', integrationName: 'GitHub', command: '/github:triage', name: 'triage',
      description: 'Sort the open issues of one label.',
      arguments: [{ name: 'label', description: 'The label to sort', required: true }],
    },
    {
      integrationId: 'demo-mcp-linear', integrationName: 'Linear', command: '/linear:standup', name: 'standup',
      description: 'Write the standup from your Linear issues of yesterday.',
      arguments: [],
    },
  ],
  signIn: [{ integrationId: 'demo-mcp-sentry', integrationName: 'Sentry', slug: 'sentry', needs: 'sign-in' }],
}

/** The text each demo prompt expands to, from its arguments. */
export function demoPromptText(name: string, values: ReadonlyMap<string, string>): string {
  if (name === 'review_pr') {
    const focus = values.get('focus')
    return [
      `Review pull request #${values.get('number')} of acme/web.`,
      'Read the diff, the linked issue, and the checks. List each problem with its file and line, the most severe first.',
      ...(focus ? [`Look at ${focus} first.`] : []),
      'Assistant:\nI will read the diff and the checks first.',
    ].join('\n\n')
  }
  if (name === 'triage') return `Sort the open issues with the label "${values.get('label')}" by severity, and propose an owner for each.`
  return 'Write my standup from the Linear issues I changed yesterday: what I did, what I do today, and what blocks me.'
}
