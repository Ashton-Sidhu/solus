import { definePlugin } from '@oxlint/plugins'

import { noBroadUnknownRecordsRule } from './rules/no-broad-unknown-records.ts'
import { noGithubTaskEscapesRule } from './rules/no-github-task-escapes.ts'
import { noHostApiEscapesRule } from './rules/no-host-api-escapes.ts'
import { noPassThroughWrappersRule } from './rules/no-pass-through-wrappers.ts'
import { noPierreDiffEscapesRule } from './rules/no-pierre-diff-escapes.ts'
import { noPrContextEscapesRule } from './rules/no-pr-context-escapes.ts'
import { noTailwindClassVariablesRule } from './rules/no-tailwind-class-variables.ts'
import { requireResolvedCwdRule } from './rules/require-resolved-cwd.ts'

const solusPlugin = definePlugin({
  meta: { name: 'solus' },
  rules: {
    'no-broad-unknown-records': noBroadUnknownRecordsRule,
    'no-github-task-escapes': noGithubTaskEscapesRule,
    'no-host-api-escapes': noHostApiEscapesRule,
    'no-pass-through-wrappers': noPassThroughWrappersRule,
    'no-pierre-diff-escapes': noPierreDiffEscapesRule,
    'no-pr-context-escapes': noPrContextEscapesRule,
    'no-tailwind-class-variables': noTailwindClassVariablesRule,
    'require-resolved-cwd': requireResolvedCwdRule,
  },
})

export default solusPlugin
