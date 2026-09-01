import { RuleTester } from 'oxlint/plugins-dev'

import { noGithubTaskEscapesRule } from './no-github-task-escapes.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

const taskLayerFile = 'packages/server/src/tasks/upstream.ts'
const adapterFile = 'packages/server/src/tasks/adapters/github.ts'
const providerFile = 'packages/server/src/tasks/providers/github.ts'

tester.run('solus/no-github-task-escapes', noGithubTaskEscapesRule, {
  valid: [
    // The adapter is the boundary: it exists to talk to the provider.
    {
      code: 'const task = await provider.updateTask(id, patch);',
      filename: adapterFile,
    },
    {
      code: 'const res = await rest.issues.createComment({ body });',
      filename: providerFile,
    },
    // A resolved adapter is the whole point of the rule.
    {
      code: 'const adapter = taskSyncAdapter("github"); await adapter.postComment(ref, body);',
      filename: taskLayerFile,
    },
    {
      code: 'const adapter = this.adapterFor(link.provider); await adapter.pushFields(ref, patch);',
      filename: taskLayerFile,
    },
    // An adapter arriving by annotation is as trusted as one resolved locally.
    {
      code: 'async function send(adapter: TaskSyncAdapter, ref, body) { await adapter.postComment(ref, body); }',
      filename: taskLayerFile,
    },
    {
      code: 'const adapter: TaskSyncAdapter = registry.get("github"); await adapter.createTicket(target, patch);',
      filename: taskLayerFile,
    },
    // A field that holds an adapter is the adapter.
    {
      code: 'const ticket = await target.adapter.createTicket(target.ref, patch);',
      filename: taskLayerFile,
    },
    // Reads cannot diverge, so they are free.
    {
      code: 'const task = await provider.getTask(id);',
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
      code: 'await provider.postComment(id, body);',
      filename: taskLayerFile,
      errors: [{ messageId: 'providerWrite' }],
    },
    {
      code: 'return withProjectKey(await provider.updateTask(id, patch), cwd);',
      filename: taskLayerFile,
      errors: [{ messageId: 'providerWrite' }],
    },
    {
      code: 'await makeGitHubTaskProvider(cwd).then((p) => p.postComment(id, body));',
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
    // A binding that was never resolved from an adapter factory is a provider,
    // whatever it happens to be called.
    {
      code: 'const adapter = new GitHubTaskProvider(repo); await adapter.postComment(id, body);',
      filename: taskLayerFile,
      errors: [{ messageId: 'providerWrite' }],
    },
  ],
})
