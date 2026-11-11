import { RuleTester } from 'oxlint/plugins-dev'

import { noGithubTaskEscapesRule } from './no-github-task-escapes.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

const taskLayerFile = 'packages/server/src/data/tasks/task.ts'
const sourceFile = 'packages/server/src/data/tasks/sources/github-repo.ts'
const providerFile = 'packages/server/src/data/tasks/providers/github.ts'

tester.run('solus/no-github-task-escapes', noGithubTaskEscapesRule, {
  valid: [
    // The adapters are the boundary: they exist to talk to the provider.
    {
      code: 'const res = await rest.issues.create({ title });',
      filename: sourceFile,
    },
    {
      code: 'const res = await rest.issues.createComment({ body });',
      filename: providerFile,
    },
    // A bound adapter is the whole point of the rule.
    {
      code: 'const provider = taskAdapters().provider(home.provider); await provider.publishAssets(home, body);',
      filename: taskLayerFile,
    },
    // An adapter arriving by annotation is as trusted as one bound locally.
    {
      code: 'async function send(provider: TaskProviderAdapter, home, body) { await provider.publishAssets(home, body); }',
      filename: taskLayerFile,
    },
    // A field that holds an adapter is the adapter.
    {
      code: 'const published = await target.adapter.publishAssets(target.home, body);',
      filename: taskLayerFile,
    },
    // Reads cannot diverge, so they are free.
    {
      code: 'const task = await client.fetch(ref);',
      filename: taskLayerFile,
    },
    {
      code: 'const list = await rest.issues.listComments({ owner, repo });',
      filename: taskLayerFile,
    },
    // Outside the task layer the rule says nothing: PR conversation comments are
    // a different domain that happens to share GitHub's issues namespace.
    {
      code: 'await rest.issues.createComment({ owner, repo, body });',
      filename: 'packages/server/src/providers/github/provider.ts',
    },
  ],
  invalid: [
    {
      code: 'await client.publishAssets(home, body);',
      filename: taskLayerFile,
      errors: [{ messageId: 'providerWrite' }],
    },
    {
      code: 'await makeClient(cwd).then((client) => client.publishAssets(home, body));',
      filename: taskLayerFile,
      errors: [{ messageId: 'providerWrite' }],
    },
    {
      code: 'await rest.issues.createComment({ owner, repo, body });',
      filename: taskLayerFile,
      errors: [{ messageId: 'restWrite' }],
    },
    {
      code: 'await rest.issues.update({ owner, repo, state: "closed" });',
      filename: taskLayerFile,
      errors: [{ messageId: 'restWrite' }],
    },
    // A binding that was never bound from the adapter registry is a raw client,
    // whatever it happens to be called.
    {
      code: 'const provider = new GitHubTaskProvider(run); await provider.publishAssets(home, body);',
      filename: taskLayerFile,
      errors: [{ messageId: 'providerWrite' }],
    },
  ],
})
