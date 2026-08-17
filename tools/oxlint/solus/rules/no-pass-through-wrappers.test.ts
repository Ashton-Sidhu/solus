import { RuleTester } from 'oxlint/plugins-dev'

import { noPassThroughWrappersRule } from './no-pass-through-wrappers.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const error = { messageId: 'passThroughWrapper' }

tester.run('solus/no-pass-through-wrappers', noPassThroughWrappersRule, {
  valid: [
    'items.map((item) => format(item));',
    'const parse = (value: string) => { validate(value); return parser.parse(value); };',
    'const load = (id = defaultId) => repository.load(id);',
    'const load = (id: string) => repository.load(normalize(id));',
    'const load = (id: string) => repository.load(id, options);',
    'const load = async (id: string) => await repository.load(id);',
    'const load = repository.load;',
    'const load = (id: string) => repository.load(id);',
    'class Store { has(id: string) { return this.items.has(id); } }',
    'const api = { load(id: string) { return repository.load(id); } };',
    'function subscribe() { const callback = (value: string) => notify(value); return callback; }',
  ],
  invalid: [
    { code: 'function load(id: string) { return loadUser(id); }', errors: [error] },
    { code: 'const load = (id: string) => loadUser(id);', errors: [error] },
    { code: 'const ready = () => isReady();', errors: [error] },
    { code: 'const load = (...ids: string[]) => loadUsers(...ids);', errors: [error] },
  ],
})
