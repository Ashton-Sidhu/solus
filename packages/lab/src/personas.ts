/**
 * The people of the Lab (plan §8.1). Each persona is one LabClient; the issuer mints
 * grants from these facts, so the host sees exactly what the cloud would tell it.
 */
export type Persona =
  | { id: string; kind: 'host-owner'; userId: string; displayName: string }
  | { id: string; kind: 'org-member'; userId: string; displayName: string; organizationId: string; organizationRole: 'owner' | 'member'; teamIds: string[] }
  | { id: string; kind: 'guest'; guestId: string; displayName: string }

export const ORGANIZATION_ID = 'org-lab'
export const OTHER_ORGANIZATION_ID = 'org-elsewhere'
export const TEAM_A = 'team-a'

/**
 * alice   founded the organization; on a personal host she is also the machine's owner.
 * bob     an organization member in no team.
 * cara    an organization member in team A.
 * dan     an organization member in no team, who starts the seats scenario with no provider seat.
 * maya    a visitor with a link and no account.
 * carol   a member of another organization altogether; on the workspace service she sees none of the above.
 */
export const PERSONAS = {
  alice: { id: 'alice', kind: 'org-member', userId: 'user-alice', displayName: 'Alice', organizationId: ORGANIZATION_ID, organizationRole: 'owner', teamIds: [] },
  bob: { id: 'bob', kind: 'org-member', userId: 'user-bob', displayName: 'Bob', organizationId: ORGANIZATION_ID, organizationRole: 'member', teamIds: [] },
  cara: { id: 'cara', kind: 'org-member', userId: 'user-cara', displayName: 'Cara', organizationId: ORGANIZATION_ID, organizationRole: 'member', teamIds: [TEAM_A] },
  dan: { id: 'dan', kind: 'org-member', userId: 'user-dan', displayName: 'Dan', organizationId: ORGANIZATION_ID, organizationRole: 'member', teamIds: [] },
  maya: { id: 'maya', kind: 'guest', guestId: 'guest-maya-0123456789', displayName: 'Maya' },
  carol: { id: 'carol', kind: 'org-member', userId: 'user-carol', displayName: 'Carol', organizationId: OTHER_ORGANIZATION_ID, organizationRole: 'owner', teamIds: [] },
} as const satisfies Record<string, Persona>

export type PersonaId = keyof typeof PERSONAS

const PERSONA_TABLE = new Map<string, Persona>(Object.values(PERSONAS).map((persona) => [persona.id, persona]))

/** On a personal host alice is its owner: the cloud would mint her an owner grant, not a member grant. */
export function personaForHost(id: string, hostKind: 'personal' | 'managed'): Persona {
  const persona = PERSONA_TABLE.get(id)
  if (!persona) throw new Error(`Unknown persona "${id}"`)
  if (hostKind === 'personal' && id === 'alice' && persona.kind === 'org-member') {
    return { id: 'alice', kind: 'host-owner', userId: persona.userId, displayName: persona.displayName }
  }
  return persona
}
