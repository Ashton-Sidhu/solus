import { RuleTester } from 'oxlint/plugins-dev'

import { noPassThroughWrappersRule } from './no-pass-through-wrappers.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const error = { messageId: 'passThroughWrapper' }
const composed = { messageId: 'composedWrapper' }

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
    // A member callee binds a receiver, so the wrapper is doing something the
    // caller would otherwise have to repeat.
    'class Store { chipFor(id: string) { return this.chips.get(this.choicesFor(id)); } }',
    // Composing two of its own methods keeps both private to the object.
    'class Store { chipFor(id: string) { return this.chipOf(this.choicesFor(id)); } }',
    // A callee declared in this file may be private to it, so the method can be
    // the only way to reach it — a narrower interface, which earns a wrapper.
    'function chipOf(c: C) { return c; }\nclass Store { chipFor(id: string) { return chipOf(this.choicesFor(id)); } }',
    // The argument is transformed, not forwarded.
    "import { chipOf } from './chips';\nclass Store { chipFor(id: string) { return chipOf(this.choicesFor(normalize(id))); } }",
    // More than one argument means the method is composing a call the caller
    // cannot make from its parts alone.
    "import { chipOf } from './chips';\nclass Store { chipFor(id: string) { return chipOf(this.choicesFor(id), this.style); } }",
    "import { chipsOf } from './chips';\nclass Store { get chips() { return chipsOf(this.choices); } }",
    // An adapter satisfying an interface has to declare the member; a forwarding
    // body there is the contract, not a wrapper hiding one.
    "import { keyOf } from './keys';\nclass Adapter implements TaskSyncAdapter { statusKey(status: Status) { return keyOf(this.mapping(status)); } }",
    "import { chipOf } from './chips';\nclass Store extends Base { chipFor(id: string) { return chipOf(this.choicesFor(id)); } }",
  ],
  invalid: [
    { code: 'function load(id: string) { return loadUser(id); }', errors: [error] },
    { code: 'const load = (id: string) => loadUser(id);', errors: [error] },
    { code: 'const ready = () => isReady();', errors: [error] },
    { code: 'const load = (...ids: string[]) => loadUsers(...ids);', errors: [error] },
    // WHY: the shape this rule was extended for. `prChipFor` returned
    // `prChipForChoices(this.prChoicesFor(task))` — a second name for two calls
    // every caller could already make, which is how one surface ends up reading
    // the wrapper and the next one the pair.
    {
      code: "import { chipForChoices } from './task-list';\nclass Store { chipFor(task: Task) { return chipForChoices(this.choicesFor(task)); } }",
      errors: [composed],
    },
    {
      code: "import { chipForChoices } from './task-list';\nclass Store { chipFor(a: A, b: B) { return chipForChoices(this.choicesFor(a, b)); } }",
      errors: [composed],
    },
  ],
})
