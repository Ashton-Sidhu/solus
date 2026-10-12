import { describe, expect, test } from 'bun:test'
import { explainSigningFailure, parseSigningIdentities, signingTeamOf } from '@solus/server/devices/device-signing'

/**
 * Signing a build for a person's own iPhone or iPad: the host finds the Apple
 * teams it can sign for, and a signing failure says what to fix.
 */

describe('signing teams on the host', () => {
  test('only Apple signing identities are read, once each', () => {
    const stdout = [
      '  1) 80EBA4A89A18E787F9585A1B416BC64CAFA70DA3 "Developer ID Application: Ashton Sidhu (F4AQ9YJ7Q3)"',
      '  2) 80EBA4A89A18E787F9585A1B416BC64CAFA70DA3 "Developer ID Application: Ashton Sidhu (F4AQ9YJ7Q3)"',
      '  3) 1111111111111111111111111111111111111111 "Apple Development: ash@example.com (ZX81QQ2W3E)"',
      '  4) 2222222222222222222222222222222222222222 "Some Local Signing Cert"',
      '     3 valid identities found',
    ].join('\n')
    expect(parseSigningIdentities(stdout)).toEqual(['Developer ID Application: Ashton Sidhu (F4AQ9YJ7Q3)', 'Apple Development: ash@example.com (ZX81QQ2W3E)'])
  })

  test('a certificate that is not readable names no team', () => {
    expect(signingTeamOf('not a certificate')).toBeNull()
  })
})

describe('a failed phone build', () => {
  test('a signing failure says what to fix, and other failures are left alone', () => {
    // WHY: "exit 65" told the person nothing; each of these has one fix they can do.
    expect(explainSigningFailure('error: Signing for "Solus" requires a development team. Select a development team in the Signing & Capabilities editor.')).toContain('Signing team')
    expect(explainSigningFailure('error: No Accounts: Add a new account in Accounts settings.')).toContain('Xcode → Settings → Accounts')
    expect(explainSigningFailure('error: Your team has no devices from which to generate a provisioning profile.')).toContain('pair your iPhone')
    expect(explainSigningFailure("error: No profiles for 'sh.solus.mobile' were found")).toContain('Accounts')
    expect(explainSigningFailure(`error: Provisioning profile "iOS Team Provisioning Profile: sh.solus.mobile" doesn't match the entitlements file's value for the com.apple.security.application-groups entitlement. (in target 'Solus' from project 'Solus')`)).toContain('com.apple.security.application-groups entitlement')
    expect(explainSigningFailure('error: Build input file cannot be found')).toBeNull()
  })
})
