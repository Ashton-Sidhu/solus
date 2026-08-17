import { RuleTester } from 'oxlint/plugins-dev'

import { noHostApiEscapesRule } from './no-host-api-escapes.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('solus/no-host-api-escapes', noHostApiEscapesRule, {
  valid: [
    'const api: HostApi = resolveApi();',
    'const value = response as Result;',
    'const value = item as any;',
    'window.solus = api;',
    { code: 'const api = source as HostApi;', filename: 'src/client-core/host-api.ts' },
    { code: 'window.solus.listSessions();', filename: 'src/preload/index.ts' },
  ],
  invalid: [
    {
      code: 'const api = source as HostApi;',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'hostApiCast' }],
    },
    {
      code: 'const api = source as SolusAPI;',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'hostApiCast' }],
    },
    {
      code: 'const api = source as typeof window.solus;',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'ambientSolusType' }],
    },
    {
      code: 'const value = hostApi as any;',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'apiAnyCast' }],
    },
    {
      code: 'window.solus.listSessions();',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'ambientSolusAccess' }],
    },
    {
      code: 'window.solus?.listSessions?.();',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'ambientSolusAccess' }],
    },
    {
      code: 'const api = <HostApi>source;',
      filename: 'src/feature.ts',
      errors: [{ messageId: 'hostApiCast' }],
    },
  ],
})
