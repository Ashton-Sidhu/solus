import { RuleTester } from 'oxlint/plugins-dev'

import { noPollingLoopInTestsRule } from './no-polling-loop-in-tests.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const error = { messageId: 'pollingLoop' }
const filename = 'tests/unit/fixture.test.ts'

tester.run('solus/no-polling-loop-in-tests', noPollingLoopInTestsRule, {
  valid: [
    // A fixed-count flush asks nothing of the system under test.
    {
      code: 'async function flush() { for (let i = 0; i < 3; i++) await Promise.resolve() }',
      filename,
    },
    {
      code: 'async function flush(turns: number) { let i = 0; do { await sleep(1); i += 1 } while (i < turns) }',
      filename,
    },
    // Code after a fixed-count loop is not part of the loop.
    {
      code: 'async function flush() { for (let i = 0; i < 3; i++) await Promise.resolve(); if (!ready()) throw new Error("no") }',
      filename,
    },
    // A loop that awaits real events is not a timer poll.
    {
      code: 'async function until(next: () => Promise<number>) { while (true) { const event = await next(); if (event > 2) return event } }',
      filename,
    },
    // A wait inside a nested callback runs on the callback's schedule.
    {
      code: 'async function run(items: number[], done: () => boolean) { for (const item of items) { if (done()) return; queue(async () => { await sleep(item) }) } }',
      filename,
    },
    // Production code may poll; the rule reads test files only.
    {
      code: 'async function waitFor(done: () => boolean) { while (!done()) await new Promise((resolve) => setTimeout(resolve, 10)) }',
      filename: 'packages/server/src/git/git-watcher.ts',
    },
  ],
  invalid: [
    {
      code: 'async function waitFor(done: () => boolean) { while (!done()) await new Promise((resolve) => setTimeout(resolve, 10)) }',
      filename,
      errors: [error],
    },
    {
      code: 'async function waitFor(done: () => boolean) { do { await new Promise((resolve) => setTimeout(resolve, 10)) } while (!done()) }',
      filename,
      errors: [error],
    },
    // A budgeted poll is still a poll: the predicate decides when it stops.
    {
      code: 'async function waitFor(done: () => boolean) { for (let attempt = 0; attempt < 50; attempt++) { if (done()) return; await sleep(20) } throw new Error("timed out") }',
      filename,
      errors: [error],
    },
    {
      code: 'async function waitFor(done: () => boolean) { while (true) { if (done()) break; await Promise.resolve() } }',
      filename,
      errors: [error],
    },
    {
      code: 'async function waitFor(events: string[]) { while (events.length < 1) await Bun.sleep(5) }',
      filename,
      errors: [error],
    },
    // A comparison against a value the loop never advances is a predicate.
    {
      code: 'async function waitFor(state: { count: number }) { let seen = state.count; while (seen < 3) { await delay(5); seen = state.count } }',
      filename,
      errors: [error],
    },
    {
      code: 'async function waitFor(until: () => boolean) { for (let attempt = 0; attempt < 30 && !until(); attempt++) await setTimeout(10) }',
      filename: 'packages/client-core/src/registry.spec.ts',
      errors: [error],
    },
    {
      code: 'async function waitFor(done: () => boolean) { while (!done()) await new Promise(setImmediate) }',
      filename,
      errors: [error],
    },
  ],
})
