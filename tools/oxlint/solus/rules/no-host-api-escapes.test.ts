import { RuleTester } from 'oxlint/plugins-dev'

import { noHostApiEscapesRule } from './no-host-api-escapes.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('solus/no-host-api-escapes', noHostApiEscapesRule, {
  valid: [
    'const api: HostApi = resolveApi();',
    'const value = response as Result;',
    'const value = item as any;',
    'window.solus = api;',
    { code: 'const api = source as HostApi;', filename: 'packages/client-core/src/host-api.ts' },
    { code: 'window.solus.listSessions();', filename: 'apps/desktop/src/preload/index.ts' },
  ],
  invalid: [
    {
      code: 'const api = source as HostApi;',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'hostApiCast' }],
    },
    {
      code: 'const api = source as SolusAPI;',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'hostApiCast' }],
    },
    {
      code: 'const api = source as typeof window.solus;',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'ambientSolusType' }],
    },
    {
      code: 'const value = hostApi as any;',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'apiAnyCast' }],
    },
    {
      code: 'window.solus.listSessions();',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'ambientSolusAccess' }],
    },
    {
      code: 'window.solus?.listSessions?.();',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'ambientSolusAccess' }],
    },
    {
      code: 'const api = <HostApi>source;',
      filename: 'packages/workspace-ui/src/feature.ts',
      errors: [{ messageId: 'hostApiCast' }],
    },
  ],
})
