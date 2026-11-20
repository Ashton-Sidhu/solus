import { describe, expect, test } from 'bun:test'
import type { IntegrationResource } from '@solus/contracts/integration-types'
import { resourceAttachments, resourceSections } from '../../apps/mobile/src/features/conversation/lib/resource-attachments'

/** The mobile "MCP Resource…" sheet and what a read adds to the composer (mcp-first-class.md §11.3). */
describe('mobile MCP resources', () => {
  const integrations = [{ id: 'int-wiki', name: 'Wiki' }, { id: 'int-docs', name: 'Docs' }, { id: 'int-empty', name: 'Empty' }]
  const resources: IntegrationResource[] = [
    { integrationId: 'int-wiki', uri: 'wiki://home', name: 'home' },
    { integrationId: 'int-docs', uri: 'docs://notes', name: 'notes', title: 'Release notes' },
    { integrationId: 'int-docs', uri: 'docs://spec', name: 'spec' },
  ]

  test('the sheet groups resources by server in name order and leaves out a server with none', () => {
    expect(resourceSections(integrations, resources, '').map((section) => [section.title, section.data.map((resource) => resource.name)]))
      .toEqual([['Docs', ['notes', 'spec']], ['Wiki', ['home']]])
  })

  test('the search matches the title and the URI', () => {
    expect(resourceSections(integrations, resources, 'release').flatMap((section) => section.data.map((resource) => resource.uri))).toEqual(['docs://notes'])
    expect(resourceSections(integrations, resources, 'wiki://').flatMap((section) => section.data.map((resource) => resource.uri))).toEqual(['wiki://home'])
  })

  test('a read becomes the composer\'s attachments by host path; an image carries no bytes', () => {
    expect(resourceAttachments([
      { id: 'a', type: 'image', name: 'Logo.png', path: '/host/a/Logo.png', hostPath: '/host/a/Logo.png', mimeType: 'image/png', size: 70 },
      { id: 'b', type: 'file', name: 'notes.md', path: '/host/b/notes.md', hostPath: '/host/b/notes.md', mimeType: 'text/markdown', size: 12 },
    ])).toEqual([
      { id: 'a', kind: 'image', name: 'Logo.png', hostPath: '/host/a/Logo.png', mimeType: 'image/png', size: 70, dataUrl: null },
      { id: 'b', kind: 'file', name: 'notes.md', hostPath: '/host/b/notes.md', mimeType: 'text/markdown', size: 12, dataUrl: null },
    ])
  })
})
