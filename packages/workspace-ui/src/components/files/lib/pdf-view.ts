/// <reference types="vite/client" />
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const SCALE_STEP = 1.25

export interface PdfViewState {
  pageCount: number
  currentPage: number
  scalePercent: number
  /** The find result: `null` before a search, total 0 when nothing matched. */
  matches: { current: number; total: number } | null
}

export interface PdfView {
  zoomIn(): void
  zoomOut(): void
  fitWidth(): void
  /** Search the text of every page. `again` steps to the next or previous match. */
  find(query: string, options?: { again?: boolean; backwards?: boolean }): void
  destroy(): void
}

type ViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs')
let viewerModule: Promise<ViewerModule> | null = null

/** The viewer build reads the core library from a global, so the global is set
 *  before that module is evaluated. */
function loadViewerModule(): Promise<ViewerModule> {
  if (!viewerModule) {
    const pdfjsGlobal: typeof globalThis & { pdfjsLib?: typeof pdfjsLib } = globalThis
    pdfjsGlobal.pdfjsLib = pdfjsLib
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
    viewerModule = import('pdfjs-dist/web/pdf_viewer.mjs')
  }
  return viewerModule
}

/**
 * Show the PDF at `url`: every page stacked in `container`, with a text layer
 * for selection and find. `container` must be absolutely positioned and scroll;
 * the pages render into `viewer`, its only child. Rejects when the file is not a
 * readable PDF.
 */
export async function openPdfView(
  url: string,
  container: HTMLDivElement,
  viewer: HTMLDivElement,
  onChange: (state: PdfViewState) => void,
): Promise<PdfView> {
  const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await loadViewerModule()
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const findController = new PDFFindController({ linkService, eventBus })
  const pdfViewer = new PDFViewer({ container, viewer, eventBus, linkService, findController, removePageBorders: true })
  linkService.setViewer(pdfViewer)

  let state: PdfViewState = { pageCount: 0, currentPage: 1, scalePercent: 100, matches: null }
  const update = (patch: Partial<PdfViewState>): void => {
    state = { ...state, ...patch }
    onChange(state)
  }
  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = 'page-width'
    update({ pageCount: pdfViewer.pagesCount })
  })
  eventBus.on('scalechanging', ({ scale }: { scale: number }) => update({ scalePercent: Math.round(scale * 100) }))
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => update({ currentPage: pageNumber }))
  const onMatches = ({ matchesCount }: { matchesCount: { current: number; total: number } }) => update({ matches: matchesCount })
  eventBus.on('updatefindmatchescount', onMatches)
  eventBus.on('updatefindcontrolstate', onMatches)

  const loadingTask = pdfjsLib.getDocument({ url })
  try {
    const document = await loadingTask.promise
    pdfViewer.setDocument(document)
    linkService.setDocument(document)
  } catch (error) {
    void loadingTask.destroy()
    throw error
  }

  return {
    zoomIn: () => {
      pdfViewer.currentScale = Math.min(MAX_SCALE, pdfViewer.currentScale * SCALE_STEP)
    },
    zoomOut: () => {
      pdfViewer.currentScale = Math.max(MIN_SCALE, pdfViewer.currentScale / SCALE_STEP)
    },
    fitWidth: () => {
      pdfViewer.currentScaleValue = 'page-width'
    },
    find: (query, options = {}) => {
      if (!query) {
        eventBus.dispatch('findbarclose', { source: pdfViewer })
        update({ matches: null })
        return
      }
      eventBus.dispatch('find', {
        source: pdfViewer,
        type: options.again ? 'again' : '',
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: options.backwards === true,
        matchDiacritics: false,
      })
    },
    destroy: () => {
      pdfViewer.cleanup()
      void loadingTask.destroy()
    },
  }
}
