import {
  Cloud as CloudIcon,
  CloudOff as CloudSlashIcon,
  Earth as GlobeSimpleIcon,
} from '@lucide/svelte'
import type { Component } from 'svelte'
import AppleLogoIcon from '../../components/ui/AppleLogoIcon.svelte'
import LinuxLogoIcon from '../../components/ui/LinuxLogoIcon.svelte'
import WindowsLogoIcon from '../../components/ui/WindowsLogoIcon.svelte'
import type { HostOperatingSystem } from '@solus/contracts/types'
import type { SavedServerUplink } from '@solus/client-core/server-registry'
import { hostReadinessCopy, type HostReadiness, type HostReadinessState } from '@solus/client-core/host-readiness'

/** The host a surface belongs to, in the facts every badge needs. */
export interface HostAffinityTarget {
  label: string
  local: boolean
  os?: HostOperatingSystem
  /** A managed host wears a cloud, whatever it runs on. */
  uplink?: Pick<SavedServerUplink, 'kind'>
}

export interface HostAffinityGlyph {
  icon: Component
  /** Tailwind colour + motion utilities for the glyph itself. */
  className: string
  /** The host state in one word, for rows that have room to print it. */
  statusLabel: string
  tooltip: string
}

/** The availability dot beside a host, with motion only while it is dialed. */
export function readinessDotClass(readiness: HostReadiness): string {
  if (readiness === 'ready') return 'bg-(--solus-status-complete)'
  if (readiness === 'checking' || readiness === 'reconnecting') return 'animate-pulse bg-(--solus-accent)'
  return 'bg-(--solus-status-error)'
}

/**
 * The whole question a user has about a dispatched session is "is that host
 * still there", so the badge answers it in the glyph rather than beside it — a
 * status dot marks all three states with equal weight when only one is worth
 * interrupting for. A host that is not ready changes shape as well as colour,
 * so the state reads in both themes and without relying on colour vision.
 *
 * Returns null for the host you are working on: local is the unmarked case, and
 * a desktop-tower badge "for symmetry" doubles the chrome for the majority.
 */
export function hostAffinityGlyph(
  host: HostAffinityTarget | null | undefined,
  readiness: HostReadinessState,
): HostAffinityGlyph | null {
  if (!host || host.local) return null
  const statusLabel = hostReadinessCopy(readiness, host.label).label
  const hostIcon = host.uplink?.kind === 'managed' ? CloudIcon : operatingSystemIcon(host.os)
  return { ...glyphFor(readiness.readiness, hostIcon), statusLabel, tooltip: `Runs on ${host.label} · ${statusLabel}` }
}

function glyphFor(readiness: HostReadiness, hostIcon: Component): Pick<HostAffinityGlyph, 'icon' | 'className'> {
  if (readiness === 'checking' || readiness === 'reconnecting') return { icon: hostIcon, className: 'animate-pulse text-(--solus-accent)' }
  if (readiness === 'ready') return { icon: hostIcon, className: 'text-(--solus-text-tertiary)' }
  return { icon: CloudSlashIcon, className: 'text-(--solus-status-error)' }
}

function operatingSystemIcon(os?: HostOperatingSystem): Component {
  if (os === 'macos') return AppleLogoIcon
  if (os === 'windows') return WindowsLogoIcon
  if (os === 'linux') return LinuxLogoIcon
  return GlobeSimpleIcon
}
