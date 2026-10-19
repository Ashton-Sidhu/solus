import type { ReactNode } from 'react'

/** iOS settings pages have no workspace navigation of their own (WorkspaceSettingsFrame.android.tsx). */
export function WorkspaceSettingsFrame(props: { readonly children: ReactNode }) {
  return props.children
}
