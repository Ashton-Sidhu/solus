import type { AppState } from '@solus/contracts/apps'
import type { ScreenProps } from '../../../navigation/routes'

/** What each section of the Manage screen gets from its screen. */
export interface AppSectionProps {
  readonly hostId: string
  /** The app's id on its host. */
  readonly appId: string
  readonly state: AppState
  readonly connected: boolean
  /** Reads the app's state again, after a change of it. */
  readonly reloadState: () => void
  readonly navigation: ScreenProps<'AppSection'>['navigation']
}
