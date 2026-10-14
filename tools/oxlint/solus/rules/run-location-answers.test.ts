import { RuleTester } from 'oxlint/plugins-dev'

import { runLocationAnswersRule } from './run-location-answers.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('solus/run-location-answers', runLocationAnswersRule, {
  valid: [
    { code: 'const host = runHost(session.run);', filename: 'packages/workspace-ui/src/feature.ts' },
    { code: 'draft.run.location = openFolder(draft.run.location, place);', filename: 'packages/workspace-ui/src/feature.ts' },
    { code: 'const host = run.location.checkout.serverId;', filename: 'packages/workspace-ui/src/contexts/workspace/run-location.ts' },
    { code: 'const id = scope.checkout.serverId;', filename: 'packages/workspace-ui/src/feature.ts' },
    { code: 'const host = run.location.checkout.serverId;', filename: 'packages/server/src/feature.ts' },
  ],
  invalid: [
    {
      code: 'const host = session.run.location.checkout.serverId;',
      filename: 'packages/workspace-ui/src/components/input/InputBarHeader.svelte.ts',
      errors: [{ messageId: 'reachedIn' }],
    },
    {
      code: 'const home = run.location.project;',
      filename: 'apps/desktop/src/renderer/shell/feature.ts',
      errors: [{ messageId: 'reachedIn' }],
    },
  ],
})
