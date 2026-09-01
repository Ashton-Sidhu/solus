import { RuleTester } from 'oxlint/plugins-dev'

import { noTailwindClassVariablesRule } from './no-tailwind-class-variables.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const error = { messageId: 'hiddenClassList' }
const component = 'packages/workspace-ui/src/components/tasks/TaskCard.svelte'

tester.run('solus/no-tailwind-class-variables', noTailwindClassVariablesRule, {
  valid: [
    // A style module outside a component is a deliberate sharing decision.
    {
      code: "const ROW = 'flex h-7 items-center gap-3 text-workspace-chrome';",
      filename: 'packages/workspace-ui/src/components/automations/lib/rail-styles.ts',
    },
    { code: "const display = 'flex';", filename: component },
    { code: "const label = 'Rename this task';", filename: component },
    { code: "const query = 'select id from tasks';", filename: component },
    { code: 'const classes = `flex gap-2 ${extra}`;', filename: component },
    { code: "const state = { classes: 'flex items-center gap-2' };", filename: component },
  ],
  invalid: [
    {
      code: "const row = 'flex items-center gap-2 text-muted-foreground';",
      filename: component,
      errors: [error],
    },
    {
      code: "let chip = 'rounded-full px-2 py-0.5';",
      filename: 'packages/workspace-ui/src/components/tasks/task-card.svelte.ts',
      errors: [error],
    },
    {
      code: "const trigger = 'hover:bg-muted focus-visible:outline-none [&>svg]:size-3';",
      filename: component,
      errors: [error],
    },
    {
      code: "const field = 'h-7 rounded-md ' + 'border-0 bg-transparent';",
      filename: component,
      errors: [error],
    },
    {
      code: 'const field = `h-7 border-0 bg-transparent`;',
      filename: component,
      errors: [error],
    },
  ],
})
