import { RuleTester } from 'oxlint/plugins-dev'

import { actingIdentityRule } from './acting-identity.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

const serverFile = 'packages/server/src/git/worktree-manager.ts'
const hostToolFile = 'packages/server/src/code-intel/tool-installer.ts'

tester.run('solus/acting-identity', actingIdentityRule, {
  valid: [
    // The launch point decides the environment and the user.
    { code: 'const run = launchProcess(bin, args, { FORCE_COLOR: "0" }); spawn(run.file, run.args, { env: run.env })', filename: serverFile },
    { code: 'const run = launchedProcess(await currentIdentity().launchOptions(extra), bin, args)', filename: serverFile },
    { code: 'const env = await currentIdentity().env(extra)', filename: serverFile },
    // Another object's `env()` is not an identity's.
    { code: 'run("npm", args, { env: this.env(), cwd })', filename: serverFile },
    // Reading one host variable is not handing the host's environment to a process.
    { code: 'const port = process.env.SOLUS_PORT', filename: serverFile },
    // A reviewed host-only file may name the host.
    { code: 'spawn(bin, args, { env: hostCliEnv() })', filename: hostToolFile },
    // Outside the server the rule says nothing.
    { code: 'const env = { ...process.env, HOST_ACTOR }', filename: 'apps/desktop/src/main/terminal-launcher.ts' },
  ],
  invalid: [
    // A member's git would carry the host's SSH agent and tokens.
    {
      code: 'spawn("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })',
      filename: serverFile,
      errors: [{ messageId: 'ambientEnv' }],
    },
    {
      code: 'execFile(bin, args, { env: process.env })',
      filename: serverFile,
      errors: [{ messageId: 'ambientEnv' }],
    },
    // Spread launch options lose the member's user: Node ignores it.
    {
      code: 'spawn(bin, args, { cwd, ...launchOptions() })',
      filename: serverFile,
      errors: [{ messageId: 'spreadLaunch' }],
    },
    {
      code: 'execFile(bin, args, { ...await currentIdentity().launchOptions(extra) })',
      filename: serverFile,
      errors: [{ messageId: 'spreadLaunch' }],
    },
    // An identity's environment alone would run a member's process as the server's user.
    {
      code: 'spawn("git", args, { env: await currentIdentity().env(extra) })',
      filename: serverFile,
      errors: [{ messageId: 'envWithoutUser' }],
    },
    {
      code: 'const seat = { home, env: identityFor(seat).envSync() }',
      filename: serverFile,
      errors: [{ messageId: 'envWithoutUser' }],
    },
    // Acting as the host for a person's work must be a reviewed decision.
    {
      code: 'await worktreeMover.move({ sessionId, actor: HOST_ACTOR })',
      filename: serverFile,
      errors: [{ messageId: 'hostName' }],
    },
    {
      code: 'withHostScope(() => fetchAll())',
      filename: serverFile,
      errors: [{ messageId: 'hostName' }],
    },
  ],
})
