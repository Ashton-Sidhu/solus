import { describe, expect, test } from 'bun:test'
import { resourceAttachRequest, type IntegrationResource } from '@solus/contracts/integration-types'
import { resourceAddress, resourceAttachments, resourceSections } from '../../apps/mobile/src/features/conversation/lib/resource-attachments'

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

describe('MCP resource templates in the + menu sheet (mcp-first-class.md §11.3)', () => {
  const servers = [{ id: 'docs', name: 'Docs' }]
  const page = { integrationId: 'docs', uriTemplate: 'docs://pages/{+path}', name: 'page', title: 'Page by path' }
  const search = { integrationId: 'docs', uriTemplate: 'docs://search{?q}', name: 'search' }

  test('a template the host can expand follows the resources of its server; another operator is left out', () => {
    // WHY: the phone attaches what desktop's @ menu attaches; a {?q} template would only fail at the host.
    const sections = resourceSections(servers, [{ integrationId: 'docs', uri: 'docs://home', name: 'home' }], '', [page, search])
    expect(sections.map((section) => section.data.map(resourceAddress))).toEqual([['docs://home', 'docs://pages/{+path}']])
    expect(resourceSections(servers, [], 'pages/', [page]).map((section) => section.data.length)).toEqual([1])
  })

  test('the values of a template go to the host as the template and its arguments, the same request as desktop', () => {
    expect(resourceAttachRequest({ ...page, arguments: [{ name: 'path', value: 'guides/start' }] }))
      .toEqual({ integrationId: 'docs', uriTemplate: 'docs://pages/{+path}', arguments: [{ name: 'path', value: 'guides/start' }] })
    expect(resourceAttachRequest({ integrationId: 'docs', uri: 'docs://home', name: 'home' })).toEqual({ integrationId: 'docs', uri: 'docs://home' })
  })
})
