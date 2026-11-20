import type { PersonalSettings } from '@solus/contracts/settings'

/** A sidebar app pin uses the host installation id so it follows the person across clients. */
export type SidebarAppPin = PersonalSettings['sidebarApps'][number]

export function isSamePin(a: SidebarAppPin, b: SidebarAppPin): boolean {
  return a.host === b.host && a.appId === b.appId
}

export function isAppPinned(pins: readonly SidebarAppPin[], pin: SidebarAppPin): boolean {
  return pins.some((candidate) => isSamePin(candidate, pin))
}

/** The pins after one app is pinned (at the end) or unpinned. */
export function withAppPinned(pins: readonly SidebarAppPin[], pin: SidebarAppPin, pinned: boolean): SidebarAppPin[] {
  const rest = pins.filter((candidate) => !isSamePin(candidate, pin))
  return pinned ? [...rest, { ...pin }] : rest
}

