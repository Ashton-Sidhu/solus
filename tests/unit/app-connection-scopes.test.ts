import { expect, test } from 'bun:test'
import { appOperationCallName } from '@solus/contracts/apps'
import type { AppProjectFiles } from './helpers/app-project'
import { call, connectionCalls, describeWithNode, installAppsHost, owner, project, service, ship, toolCalls } from './helpers/apps-host'

installAppsHost()

/**
 * The two scopes of an app's connections (docs/plans/app-deploy.md §6), in a
 * process app. A user connection is the caller's own. An app connection is the
 * owner's, for each caller and for the app's background work.
 */
const CONNECTED: AppProjectFiles = {
  app: `import { defineApp, query } from '@solus/app/backend'
export default defineApp({
  name: 'Connected',
  integrations: ['linear'],
  appIntegrations: ['github'],
  operations: {
    mine: query({}, (ctx) => ctx.tools.linear.list_issues({ team: 'ENG' })),
    ours: query({}, (ctx) => ctx.tools.github.request({ path: '/repos/acme/web/pulls' })),
    who: query({}, (ctx) => ctx.caller),
  },
})`,
}

describeWithNode('the scopes of an app\'s connections', () => {
  test('a call with no person uses an app connection, and is refused a user connection', async () => {
    // WHY: a schedule, a webhook, and a visitor of a published app have no
    // person. Before, they used each connection of the owner. Now the owner
    // names the connections that the app may use for everyone, and their own
    // connections stay their own.
    const apps = await service()
    const { app } = await ship(apps, project(CONNECTED))
    const scheduled = { kind: 'schedule', name: 'nightly' } as const
    expect(await apps.callOperation(app.id, 'ours', {}, scheduled, null)).toEqual([{ number: 7 }])
    expect(connectionCalls).toEqual([{ provider: 'github', input: { path: '/repos/acme/web/pulls' } }])
    await expect(apps.callOperation(app.id, 'mine', {}, scheduled, null)).rejects.toThrow('The integration linear is a user connection, and this call has no person. Name it in `appIntegrations` in app.ts to use the owner\'s connection.')
    expect(toolCalls).toEqual([])
  })

  test('a person\'s call uses their own connection for a user connection, and the app says which scope each one has', async () => {
    const apps = await service()
    const { app } = await ship(apps, project(CONNECTED))
    expect(await call(apps, app.id, appOperationCallName('mine'))).toEqual({ issues: ['ENG-1'] })
    expect(toolCalls).toEqual([{ integrationId: 'int-linear', tool: 'list_issues', input: { team: 'ENG' } }])
    expect((await apps.read(owner, app.id)).roles).toEqual([
      { slug: 'linear', scope: 'user', name: 'Linear', connected: true },
      { slug: 'github', scope: 'app', name: 'GitHub', connected: true },
    ])
    // The app's code reads who calls and what they may do.
    expect(await call(apps, app.id, appOperationCallName('who'))).toEqual({ kind: 'ui', role: 'owner' })
  })
})
