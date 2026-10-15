import { RuleTester } from 'oxlint/plugins-dev'

import { noPrivatePathToMemberRule } from './no-private-path-to-member.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

const serverFile = 'packages/server/src/execution/agents/tools/browser-tools.ts'

tester.run('solus/no-private-path-to-member', noPrivatePathToMemberRule, {
  valid: [
    // Building the server's own path is the server's business.
    { code: 'const seatsRoot = `${solusDir()}-seats`', filename: serverFile },
    { code: 'const file = join(dataDir(), "assets", id); writeFileSync(file, bytes)', filename: serverFile },
    // A shared path in words is what a member can open.
    { code: 'lines.push(`screenshot: ${join(sharedFilesRoot(), id)}`)', filename: serverFile },
    // A launch with nothing of the server's folder.
    { code: 'launchProcess("git", ["-C", projectPath, "status"])', filename: serverFile },
    // Outside the server the rule says nothing.
    { code: 'lines.push(`file: ${join(dataDir(), "x")}`)', filename: 'apps/desktop/src/main/index.ts' },
  ],
  invalid: [
    // The agent is told to read a file it cannot open.
    {
      code: 'lines.push(`screenshot: ${join(dataDir(), "assets", id)} (read this path)`)',
      filename: serverFile,
      errors: [{ messageId: 'text' }],
    },
    {
      code: 'const prompt = `[Attached file: ${solusDir()}/attachments/${id}]`',
      filename: serverFile,
      errors: [{ messageId: 'text' }],
    },
    // A member's process is given a path it cannot open.
    {
      code: 'launchProcess("git", ["-C", join(dataDir(), "review-checkouts", key), "fetch"])',
      filename: serverFile,
      errors: [{ messageId: 'launch' }],
    },
  ],
})
