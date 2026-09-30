import { expect, test } from 'bun:test'
import { hostLinkCommand } from '@solus/workspace-ui/components/onboarding/lib/host-link-command'
import { parseLinkCode } from '@solus/contracts/uplink'

// WHY: the command is the whole onboarding step for a server. It must link
// the host to the account origin that issued the code, or the host enrolls
// against the default cloud and the waiting page never sees it. The link code
// carries that origin itself (plans/009-organization-vms.md §5).
test('the link command installs, then links with a code that names its issuing origin', () => {
  const command = hostLinkCommand({ ticket: 'abc123_DEF-4', expiresAt: 0, directoryUrl: 'https://staging.solus.sh' })
  expect(command).toStartWith('curl -fsSL https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.sh | sh -s --')
  expect(command).toEndWith('--link abc123_DEF-4@staging.solus.sh')
  expect(parseLinkCode('abc123_DEF-4@staging.solus.sh', 'https://app.solus.sh').directoryUrl).toBe('https://staging.solus.sh')
})

test('a code with shell characters stays one argument', () => {
  const command = hostLinkCommand({ ticket: "a b'$(x)", expiresAt: 0, directoryUrl: 'https://app.solus.sh' })
  expect(command).toContain(`--link 'a b'\\''$(x)@app.solus.sh'`)
})
