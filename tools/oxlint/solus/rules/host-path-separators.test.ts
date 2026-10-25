import { RuleTester } from 'oxlint/plugins-dev'

import { hostPathSeparatorsRule } from './host-path-separators.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

const serverFile = 'packages/server/src/files/file-preview.ts'
const clientFile = 'packages/workspace-ui/src/lib/paths.ts'

tester.run('solus/host-path-separators', hostPathSeparatorsRule, {
  valid: [
    // The shared module is the answer.
    { code: 'const name = hostPathBaseName(projectPath)', filename: clientFile },
    { code: 'if (isInsideHostPath(root, filePath)) keep()', filename: serverFile },
    // A repo-relative path is written with `/` by git and every wire format.
    { code: 'const parts = relativePath.split("/")', filename: serverFile },
    // Not a host path: URLs, refs, repository keys.
    { code: 'const parts = repoKey.split("/")', filename: clientFile },
    { code: 'if (url.startsWith("/")) route()', filename: clientFile },
    { code: 'const [owner, repo] = branch.split("/")', filename: clientFile },
    // The module itself, and tests, say what they mean in their own words.
    { code: 'const parts = projectPath.split("/")', filename: 'packages/contracts/src/host-path.ts' },
    { code: 'const parts = projectPath.split("/")', filename: 'tests/unit/paths.test.ts' },
    // Outside the product code the rule says nothing.
    { code: 'const parts = projectPath.split("/")', filename: 'scripts/package-server.ts' },
  ],
  invalid: [
    // A project label that showed `C:\code\scratch` whole.
    { code: 'const label = projectPath.split("/").pop()', filename: clientFile, errors: [{ messageId: 'separator' }] },
    { code: 'const name = cwd.slice(cwd.lastIndexOf("/") + 1)', filename: clientFile, errors: [{ messageId: 'separator' }] },
    // A prefix test that never matched `C:\x\y`.
    { code: 'if (filePath.startsWith(root + "/")) keep()', filename: serverFile, errors: [{ messageId: 'separator' }] },
    { code: 'if (target.startsWith(`${worktreePath}/`)) keep()', filename: serverFile, errors: [{ messageId: 'separator' }] },
    // `C:\x` is absolute too.
    { code: 'if (!session.workingDirectory.startsWith("/")) join()', filename: clientFile, errors: [{ messageId: 'separator' }] },
    // A trailing `\` stayed.
    { code: 'const root = projectRoot.replace(/\\/+$/, "")', filename: serverFile, errors: [{ messageId: 'separator' }] },
  ],
})
