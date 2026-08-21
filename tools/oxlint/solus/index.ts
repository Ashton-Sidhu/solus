import { definePlugin } from '@oxlint/plugins'

import { noBroadUnknownRecordsRule } from './rules/no-broad-unknown-records.ts'
import { noHostApiEscapesRule } from './rules/no-host-api-escapes.ts'
import { noPassThroughWrappersRule } from './rules/no-pass-through-wrappers.ts'
import { noPierreDiffEscapesRule } from './rules/no-pierre-diff-escapes.ts'

const solusPlugin = definePlugin({
  meta: { name: 'solus' },
  rules: {
    'no-broad-unknown-records': noBroadUnknownRecordsRule,
    'no-host-api-escapes': noHostApiEscapesRule,
    'no-pass-through-wrappers': noPassThroughWrappersRule,
    'no-pierre-diff-escapes': noPierreDiffEscapesRule,
  },
})

export default solusPlugin
