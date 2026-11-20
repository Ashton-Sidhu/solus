import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const galleryModule = runes.source('image-gallery', 'packages/workspace-ui/src/components/files/lib/image-gallery.svelte.ts')
const { openGallery } = await import(runes.module('viewer', `
  import { ImageGallery } from 'image-gallery';
  export function openGallery(paths, openedPath) {
    let request = $state.raw({ paths, openedPath });
    const gallery = $derived(new ImageGallery(request.paths, request.openedPath));
    return {
      get gallery() { return gallery; },
      open(paths, openedPath) { request = { paths, openedPath }; },
    };
  }
`, { 'image-gallery': galleryModule }))

test('opens the clicked image and browses in carousel order without passing either end', () => {
  const { gallery } = openGallery(['before.png', 'after.png', 'detail.png'], 'after.png')
  expect(gallery.path).toBe('after.png')
  expect(gallery.index).toBe(1)
  expect(gallery.hasPrevious).toBe(true)
  expect(gallery.hasNext).toBe(true)
  gallery.next()
  gallery.next()
  expect(gallery.path).toBe('detail.png')
  expect(gallery.hasNext).toBe(false)
  gallery.previous()
  gallery.previous()
  gallery.previous()
  expect(gallery.path).toBe('before.png')
  expect(gallery.hasPrevious).toBe(false)
})

test('a single image has no navigation, even without a carousel list', () => {
  for (const paths of [[], ['shot.png'], ['other.png']]) {
    const { gallery } = openGallery(paths, 'shot.png')
    expect(gallery.paths).toEqual(['shot.png'])
    gallery.previous()
    gallery.next()
    expect(gallery.path).toBe('shot.png')
    expect(gallery.hasPrevious).toBe(false)
    expect(gallery.hasNext).toBe(false)
  }
})

test('new reply images do not move an open gallery; a new request starts at its clicked image', () => {
  const paths = ['first.png', 'second.png']
  const viewer = openGallery(paths, 'first.png')
  viewer.gallery.next()
  paths.unshift('new.png')
  expect(viewer.gallery.path).toBe('second.png')
  expect(viewer.gallery.paths).toEqual(['first.png', 'second.png'])
  viewer.open(paths, 'new.png')
  expect(viewer.gallery.path).toBe('new.png')
  expect(viewer.gallery.index).toBe(0)
})
