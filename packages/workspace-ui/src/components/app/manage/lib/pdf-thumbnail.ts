/// <reference types="vite/client" />
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/**
 * The first page of a PDF as a picture, for the Files section's preview.
 * Loaded on demand: the section imports this module only when a PDF is
 * selected, so pdf.js stays out of the page until then.
 */

/** The width the page is drawn at, in device pixels: twice the inspector's preview. */
const THUMBNAIL_WIDTH = 480

/** Draws page 1 of the PDF and answers it as a PNG. Rejects when the bytes are not a readable PDF. */
export async function pdfFirstPage(bytes: ArrayBuffer): Promise<Blob> {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) })
  try {
    const document = await loadingTask.promise
    const page = await document.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / base.width })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The page was not drawn.'))), 'image/png'))
  } finally {
    void loadingTask.destroy()
  }
}
