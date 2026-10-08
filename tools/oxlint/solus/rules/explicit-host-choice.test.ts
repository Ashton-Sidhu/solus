import { RuleTester } from 'oxlint/plugins-dev'

import { explicitHostChoiceRule } from './explicit-host-choice.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('solus/explicit-host-choice', explicitHostChoiceRule, {
  valid: [
    { code: 'const host = hosts.get(run.serverId);', filename: 'packages/workspace-ui/src/feature.ts' },
    { code: 'const voice = hosts.transcription;', filename: 'packages/workspace-ui/src/feature.ts' },
    { code: 'const id = serverConnections.runOnHostId();', filename: 'packages/workspace-ui/src/contexts/hosts/hosts.svelte.ts' },
    { code: 'const id = serverConnections.localServerId();', filename: 'packages/client-core/src/server-connections.ts' },
    { code: 'const api = serverConnections.apiFor(run.serverId);', filename: 'packages/workspace-ui/src/feature.ts' },
  ],
  invalid: [
    {
      code: 'const id = serverConnections.runOnHostId();',
      filename: 'packages/workspace-ui/src/contexts/feature/feature.store.svelte.ts',
      errors: [{ messageId: 'implicitHost' }],
    },
    {
      code: 'const id = serverConnections.localServerId();',
      filename: 'apps/desktop/src/renderer/shell/feature.ts',
      errors: [{ messageId: 'implicitHost' }],
    },
    {
      code: 'void serverConnections.localHostApi()?.restartApp();',
      filename: 'apps/client/src/feature.ts',
      errors: [{ messageId: 'implicitHost' }],
    },
  ],
})
