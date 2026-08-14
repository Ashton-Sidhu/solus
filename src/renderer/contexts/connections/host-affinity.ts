import {
  AppleLogoIcon,
  CloudSlashIcon,
  GlobeSimpleIcon,
  LinuxLogoIcon,
  WindowsLogoIcon,
} from 'phosphor-svelte'
import type { Component } from 'svelte'
import type { HostOperatingSystem } from '../../../shared/types'
import type { ServerItemStatus } from './servers.store.svelte'

/** The host a surface belongs to, in the two facts every badge needs. */
export interface HostAffinityTarget {
  label: string
  local: boolean
  os?: HostOperatingSystem
}

export interface HostAffinityGlyph {
  icon: Component
  /** Tailwind colour + motion utilities for the glyph itself. */
  className: string
  /** The host state in one word, for rows that have room to print it. */
  statusLabel: string
  tooltip: string
}

/** One availability vocabulary shared by every surface that presents a host. */
export function hostStatusLabel(status: ServerItemStatus): string {
  if (status === 'online') return 'Online'
  if (status === 'connecting') return 'Connecting'
  if (status === 'offline') return 'Offline'
  if (status === 'different-server') return 'Different server than expected'
  return 'Not checked'
}

/** The matching availability dot, including motion while a host is connecting. */
export function hostStatusDotClass(status: ServerItemStatus): string {
  if (status === 'online') return 'bg-(--solus-status-complete)'
  if (status === 'connecting') return 'animate-pulse bg-(--solus-accent)'
  if (status === 'offline') return 'bg-(--solus-status-error)'
  if (status === 'different-server') return 'bg-(--solus-status-error)'
  return 'bg-(--solus-text-quaternary)'
}

/**
 * The whole question a user has about a dispatched session is "is that host
 * still there", so the badge answers it in the glyph rather than beside it — a
 * status dot marks all three states with equal weight when only one is worth
 * interrupting for. Offline changes shape as well as colour, so the state reads
 * in both themes and without relying on colour vision.
 *
 * Returns null for the host you are working on: local is the unmarked case, and
 * a desktop-tower badge "for symmetry" doubles the chrome for the majority.
 */
export function hostAffinityGlyph(
  host: HostAffinityTarget | null | undefined,
  status: ServerItemStatus,
): HostAffinityGlyph | null {
  if (!host || host.local) return null
  const { icon, className, statusLabel } = glyphForStatus(status, host.os)
  return { icon, className, statusLabel, tooltip: `Runs on ${host.label} · ${statusLabel}` }
}

function glyphForStatus(
  status: ServerItemStatus,
  os?: HostOperatingSystem,
): Omit<HostAffinityGlyph, 'tooltip'> {
  const hostIcon = operatingSystemIcon(os)
  if (status === 'connecting') {
    return { icon: hostIcon, className: 'animate-pulse text-(--solus-accent)', statusLabel: hostStatusLabel(status) }
  }
  if (status === 'offline' || status === 'different-server') {
    return { icon: CloudSlashIcon, className: 'text-(--solus-status-error)', statusLabel: hostStatusLabel(status) }
  }
  // A host nobody has probed yet is unknown, not unreachable — saying "offline"
  // in error red would cry wolf before anything was even dialled.
  if (status === 'saved') {
    return { icon: hostIcon, className: 'text-(--solus-text-quaternary)', statusLabel: hostStatusLabel(status) }
  }
  return { icon: hostIcon, className: 'text-(--solus-text-tertiary)', statusLabel: hostStatusLabel(status) }
}

function operatingSystemIcon(os?: HostOperatingSystem): Component {
  if (os === 'macos') return AppleLogoIcon
  if (os === 'windows') return WindowsLogoIcon
  if (os === 'linux') return LinuxLogoIcon
  return GlobeSimpleIcon
}
