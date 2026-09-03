import type { WorkType } from '@solus/contracts/types'
import { createReferenceNode } from './lib/reference-node'
import { isWorkType } from './reference-tokens'
import { TOKEN_ICONS } from './tokenStyle'

export interface WorkRefAttrs {
  workId: string
  title: string
  type: WorkType
}

function workType(value: string | null): WorkType {
  return value && isWorkType(value) ? value : 'doc'
}

export const WorkRefExtension = createReferenceNode<WorkRefAttrs>({
  name: 'workReference',
  scheme: 'work',
  dataAttr: 'data-work-ref',
  attrs: {
    workId: { default: null },
    title: { default: '' },
    type: { default: 'doc' },
  },
  fromUrl: (url, label) => ({
    workId: url.searchParams.get('workId') ?? '',
    type: workType(url.searchParams.get('type')),
    title: label,
  }),
  toToken: (attrs) => ({
    kind: 'work',
    workId: attrs.workId ?? '',
    type: attrs.type ?? 'doc',
    title: attrs.title ?? '',
  }),
  idOf: (attrs) => attrs.workId,
  label: (attrs) => attrs.title,
  variant: () => 'work',
  icon: () => TOKEN_ICONS.work,
})
