import type { McpAppPermission, McpAppPermissions } from '@solus/contracts/mcp-apps'

/**
 * Browser features an app asks for in `_meta.ui.permissions`. An app frame has
 * none of them by default; a client gives a feature to the frame only after the
 * person approves it for that app, and only a feature it can deliver.
 */

const POLICY_FEATURES = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  clipboardWrite: 'clipboard-write',
} satisfies Record<McpAppPermission, string>

const LABELS = {
  camera: 'the camera',
  microphone: 'the microphone',
  geolocation: 'your location',
  clipboardWrite: 'writing to the clipboard',
} satisfies Record<McpAppPermission, string>

/** The permissions an app asks for that this client can deliver, in a fixed order. */
export function mcpAppPermissionRequest(requested: McpAppPermissions | undefined, supported: readonly McpAppPermission[]): McpAppPermission[] {
  return supported.filter((permission) => requested?.[permission])
}

/** The frame's `allow` attribute. A bare feature name gives it to the app's own document only, not to frames it nests. */
export function mcpAppAllowAttribute(granted: readonly McpAppPermission[]): string {
  return granted.map((permission) => POLICY_FEATURES[permission]).join('; ')
}

/** The `hostCapabilities.sandbox.permissions` of what the person granted. */
export function mcpAppGrantedPermissions(granted: readonly McpAppPermission[]): McpAppPermissions {
  return Object.fromEntries(granted.map((permission) => [permission, {}]))
}

/** The words of a request: "the camera and the microphone". */
export function mcpAppPermissionLabel(permissions: readonly McpAppPermission[]): string {
  const labels = permissions.map((permission) => LABELS[permission])
  return labels.length < 2 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

/** The approval the person sees before a frame gets these features. */
export function mcpAppPermissionPrompt(title: string, permissions: readonly McpAppPermission[]) {
  return {
    title: `Allow ${title} to use ${mcpAppPermissionLabel(permissions)}?`,
    detail: 'The app reloads with this access. Your browser or system may ask you again.',
  }
}
