import { expect, test } from 'bun:test'
import { hostLinkCommand } from '@solus/workspace-ui/components/onboarding/lib/host-link-command'

// WHY: the command is the whole onboarding step for a server. It must link
// the host to the account origin that issued the code, or the host enrolls
// against the default cloud and the waiting page never sees it.
test('the link command installs, then links with the code and its issuing origin', () => {
  const command = hostLinkCommand({ ticket: 'abc123_DEF-4', expiresAt: 0, directoryUrl: 'https://staging.solus.sh' })
  expect(command).toStartWith('curl -fsSL https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.sh | sh -s --')
  expect(command).toEndWith('--link abc123_DEF-4 --cloud-url https://staging.solus.sh')
})

test('a code with shell characters stays one argument', () => {
  const command = hostLinkCommand({ ticket: "a b'$(x)", expiresAt: 0, directoryUrl: 'https://app.solus.sh' })
  expect(command).toContain(`--link 'a b'\\''$(x)'`)
})
