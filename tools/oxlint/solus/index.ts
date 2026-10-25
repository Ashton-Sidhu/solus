import { definePlugin } from '@oxlint/plugins'

import { actingIdentityRule } from './rules/acting-identity.ts'
import { explicitHostChoiceRule } from './rules/explicit-host-choice.ts'
import { hostPathSeparatorsRule } from './rules/host-path-separators.ts'
import { noBroadUnknownRecordsRule } from './rules/no-broad-unknown-records.ts'
import { noGithubTaskEscapesRule } from './rules/no-github-task-escapes.ts'
import { noHostApiEscapesRule } from './rules/no-host-api-escapes.ts'
import { noPassThroughWrappersRule } from './rules/no-pass-through-wrappers.ts'
import { noPierreDiffEscapesRule } from './rules/no-pierre-diff-escapes.ts'
import { noPrivatePathToMemberRule } from './rules/no-private-path-to-member.ts'
import { noPrContextEscapesRule } from './rules/no-pr-context-escapes.ts'
import { noTailwindClassVariablesRule } from './rules/no-tailwind-class-variables.ts'
import { requireResolvedCwdRule } from './rules/require-resolved-cwd.ts'
import { runLocationAnswersRule } from './rules/run-location-answers.ts'

const solusPlugin = definePlugin({
  meta: { name: 'solus' },
  rules: {
    'acting-identity': actingIdentityRule,
    'explicit-host-choice': explicitHostChoiceRule,
    'host-path-separators': hostPathSeparatorsRule,
    'no-broad-unknown-records': noBroadUnknownRecordsRule,
    'no-github-task-escapes': noGithubTaskEscapesRule,
    'no-host-api-escapes': noHostApiEscapesRule,
    'no-pass-through-wrappers': noPassThroughWrappersRule,
    'no-pierre-diff-escapes': noPierreDiffEscapesRule,
    'no-private-path-to-member': noPrivatePathToMemberRule,
    'no-pr-context-escapes': noPrContextEscapesRule,
    'no-tailwind-class-variables': noTailwindClassVariablesRule,
    'require-resolved-cwd': requireResolvedCwdRule,
    'run-location-answers': runLocationAnswersRule,
  },
})

export default solusPlugin
