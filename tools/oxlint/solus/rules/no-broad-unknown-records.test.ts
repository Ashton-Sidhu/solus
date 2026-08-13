import { RuleTester } from 'oxlint/plugins-dev'

import { noBroadUnknownRecordsRule } from './no-broad-unknown-records.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const error = { messageId: 'broadUnknownRecord' }

tester.run('solus/no-broad-unknown-records', noBroadUnknownRecordsRule, {
  valid: [
    'interface Metadata { requestId: string }',
    'type Metadata = Record<string, JsonValue>;',
    'type Values = Record<PropertyKey, unknown>;',
    'type Values = Map<string, unknown>;',
  ],
  invalid: [
    { code: 'type Metadata = Record<string, unknown>;', errors: [error] },
    { code: 'type Metadata = Readonly<Record<string, unknown>>;', errors: [error] },
  ],
})
