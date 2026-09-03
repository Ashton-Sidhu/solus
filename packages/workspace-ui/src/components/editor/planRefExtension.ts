import { createReferenceNode } from './lib/reference-node'
import { TOKEN_ICONS, type TokenVariant } from './tokenStyle'

export interface PlanRefAttrs {
  planId: string
  sessionId: string
  planToolUseId: string
  title: string
  status: 'pending' | 'accepted' | 'rejected'
}

const STATUS_VARIANT = {
  pending: 'plan-pending',
  accepted: 'plan-accepted',
  rejected: 'plan-rejected',
} satisfies Record<PlanRefAttrs['status'], TokenVariant>

const STATUS_ICON = {
  pending: 'plan',
  accepted: 'planAccepted',
  rejected: 'planRejected',
} satisfies Record<PlanRefAttrs['status'], keyof typeof TOKEN_ICONS>

function planStatus(value: string | null): PlanRefAttrs['status'] {
  return value === 'accepted' || value === 'rejected' ? value : 'pending'
}

export const PlanRefExtension = createReferenceNode<PlanRefAttrs>({
  name: 'planReference',
  scheme: 'plan',
  dataAttr: 'data-plan-ref',
  attrs: {
    planId: { default: null },
    sessionId: { default: null },
    planToolUseId: { default: null },
    title: { default: '' },
    status: { default: 'pending' },
  },
  fromUrl: (url, label) => ({
    planId: url.searchParams.get('planId') ?? '',
    sessionId: url.searchParams.get('sessionId') ?? '',
    planToolUseId: url.searchParams.get('planToolUseId') ?? '',
    status: planStatus(url.searchParams.get('status')),
    title: label,
  }),
  toToken: (attrs) => ({
    kind: 'plan',
    planId: attrs.planId ?? '',
    sessionId: attrs.sessionId ?? '',
    planToolUseId: attrs.planToolUseId ?? '',
    status: attrs.status ?? 'pending',
    title: attrs.title ?? '',
  }),
  idOf: (attrs) => attrs.planId,
  label: (attrs) => attrs.title,
  variant: (attrs) => STATUS_VARIANT[attrs.status] ?? 'plan-pending',
  icon: (attrs) => TOKEN_ICONS[STATUS_ICON[attrs.status] ?? 'plan'],
})
