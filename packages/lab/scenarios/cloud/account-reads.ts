import { cloudModeScenario } from '../../src/cloud-mode'
import { accountMcpServer, ownedRegisteredHost, pullAndRead } from '../../src/cloud-fixtures'

/**
 * Account reads (docs/adr/0001-standard-authentication.md §2.2 rule 7, §3.4
 * `AccountReads`; plans/020 §5): alice keeps a key for an MCP server in her account
 * vault. Her host, which holds only her personal delegation, pulls her profile, adopts
 * the connection from the cloud, and lists the server's tools with the key it read with
 * her delegated token. The server is a local fake that takes only that key, so a tool
 * list proves the key went cloud → AccountReads → host gateway → MCP server.
 */
export default cloudModeScenario('account reads: a key in the account reaches an MCP server through the host', async (ctx) => {
  ctx.step('alice registers a host and dials it; the host holds her personal delegation')
  const { alice, owner } = await ownedRegisteredHost(ctx)

  ctx.step('alice adds an MCP server to her profile and its key to her account vault')
  const mcp = await accountMcpServer(ctx, alice)
  ctx.check('the cloud checked the key with the server once', mcp.fake.mcpAuthorizations.includes(`Bearer ${mcp.key}`))
  const seenBefore = mcp.fake.mcpAuthorizations.length

  ctx.step('the host pulls her profile and adopts the connection from the cloud')
  const view = await pullAndRead(ctx, owner, mcp)
  ctx.check('the pull made the integration on the host', view.integrationId !== null)
  ctx.check('its connection is connected', view.connection?.status === 'connected', JSON.stringify(view.connection))
  ctx.check('its source is the cloud', view.connection?.source === 'cloud', view.connection?.source)
  ctx.check('the host lists the server\'s tools', view.tools.some((name) => name.includes('echo')), JSON.stringify(view.tools))
  const sinceHost = mcp.fake.mcpAuthorizations.slice(seenBefore)
  ctx.check('the host called the server with the key from the account', sinceHost.length > 0 && sinceHost.every((header) => header === `Bearer ${mcp.key}`), JSON.stringify(sinceHost.map((header) => header?.slice(0, 16))))
})
