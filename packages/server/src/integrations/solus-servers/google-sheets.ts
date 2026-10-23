import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson } from './solus-server'

/**
 * Google Sheets as a Solus MCP server (docs/plans/mcp-integrations.md
 * §13.6): Google publishes no usable Sheets MCP server. The tools are the
 * ones agents use most — a spreadsheet's sheets, reading, writing, appending,
 * and clearing cells, and adding and deleting sheets — over the Sheets API v4.
 */

const API = 'https://sheets.googleapis.com/v4/spreadsheets'

/** `spreadsheets` reads and writes the user's spreadsheets; Sheets has no narrower scope that writes. */
export const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'] as const

/** The id in a Google Sheets URL, or the text as given when it is an id already. */
function fileIdOf(idOrUrl: string): string {
  return /\/spreadsheets\/d\/([\w-]+)/.exec(idOrUrl)?.[1] ?? idOrUrl.trim()
}

const spreadsheet = z.string().min(1).describe('A spreadsheet id, or its Google Sheets URL.')
const range = z.string().min(1).describe('An A1 range, such as Sheet1!A1:D20, or a sheet name for the whole sheet.')
const cells = z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).describe('Rows of cell values, top to bottom.')
const valueInputOption = z.enum(['USER_ENTERED', 'RAW']).default('USER_ENTERED')
  .describe('USER_ENTERED reads values as typed in the Sheets UI (formulas, dates); RAW stores them as given.')
const valueRenderOption = z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).default('FORMATTED_VALUE')
  .describe('FORMATTED_VALUE as shown, UNFORMATTED_VALUE as raw numbers, FORMULA as the formulas.')

/** A path to one range's values; ranges carry `!` and `:`, so they are encoded. */
function valuesPath(id: string, a1: string): string {
  return `${API}/${encodeURIComponent(fileIdOf(id))}/values/${encodeURIComponent(a1)}`
}

function batchUpdatePath(id: string): string {
  return `${API}/${encodeURIComponent(fileIdOf(id))}:batchUpdate`
}

export const googleSheetsServer = new GoogleSolusServer({
  id: 'google-sheets',
  name: 'Google Sheets',
  description: 'Read and write cells, and add and delete sheets, in Google Sheets.',
  domain: 'sheets.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png',
  categories: ['data'],
  hosts: ['sheets.googleapis.com'],
  scopes: GOOGLE_SHEETS_SCOPES,
  tools: [
    solusTool({
      name: 'get_spreadsheet',
      description: 'A spreadsheet\'s title and its sheets, with each sheet\'s title, sheetId, and size. Read this first to find sheet names.',
      input: z.object({ spreadsheet }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const fields = 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))'
        return vendorJson(await fetch(`${API}/${encodeURIComponent(fileIdOf(input.spreadsheet))}?fields=${encodeURIComponent(fields)}`))
      },
    }),
    solusTool({
      name: 'read_range',
      description: 'The cell values in one A1 range, row by row. Empty trailing rows and cells are left out.',
      input: z.object({ spreadsheet, range, valueRenderOption }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) =>
        vendorJson(await fetch(`${valuesPath(input.spreadsheet, input.range)}?valueRenderOption=${input.valueRenderOption}`)),
    }),
    solusTool({
      name: 'read_ranges',
      description: 'The cell values in several A1 ranges at once.',
      input: z.object({ spreadsheet, ranges: z.array(range).min(1).max(50), valueRenderOption }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ valueRenderOption: input.valueRenderOption })
        for (const a1 of input.ranges) params.append('ranges', a1)
        return vendorJson(await fetch(`${API}/${encodeURIComponent(fileIdOf(input.spreadsheet))}/values:batchGet?${params}`))
      },
    }),
    solusTool({
      name: 'write_range',
      description: 'Write rows of values into a range, starting at its top-left cell. This replaces the values already in those cells.',
      input: z.object({ spreadsheet, range, values: cells, valueInputOption }),
      readOnly: false,
      // It overwrites cells, but the sheet's version history keeps the old values.
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${valuesPath(input.spreadsheet, input.range)}?valueInputOption=${input.valueInputOption}`, {
        method: 'PUT',
        body: JSON.stringify({ range: input.range, majorDimension: 'ROWS', values: input.values }),
      })),
    }),
    solusTool({
      name: 'append_rows',
      description: 'Add rows after the last row of the table found in a range. New rows are inserted, so no data is overwritten.',
      input: z.object({ spreadsheet, range: range.describe('The table to append to, such as Sheet1 or Sheet1!A:D.'), values: cells, valueInputOption }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({ valueInputOption: input.valueInputOption, insertDataOption: 'INSERT_ROWS' })
        return vendorJson(await fetch(`${valuesPath(input.spreadsheet, input.range)}:append?${params}`, {
          method: 'POST',
          body: JSON.stringify({ majorDimension: 'ROWS', values: input.values }),
        }))
      },
    }),
    solusTool({
      name: 'clear_range',
      description: 'Clear the values in a range. Formatting stays.',
      input: z.object({ spreadsheet, range }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => vendorJson(await fetch(`${valuesPath(input.spreadsheet, input.range)}:clear`, { method: 'POST', body: '{}' })),
    }),
    solusTool({
      name: 'create_spreadsheet',
      description: 'Create a spreadsheet in the user\'s Drive, with optional sheet names.',
      input: z.object({
        title: z.string().min(1),
        sheetTitles: z.array(z.string().min(1)).optional().describe('The names of its sheets; one sheet named Sheet1 when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const fields = 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)'
        return vendorJson(await fetch(`${API}?fields=${encodeURIComponent(fields)}`, {
          method: 'POST',
          // An absent `sheets` is left out of the JSON, so Google adds its default sheet.
          body: JSON.stringify({ properties: { title: input.title }, sheets: input.sheetTitles?.map((title) => ({ properties: { title } })) }),
        }))
      },
    }),
    solusTool({
      name: 'add_sheet',
      description: 'Add a sheet to a spreadsheet. The answer has the new sheet\'s sheetId.',
      input: z.object({ spreadsheet, title: z.string().min(1) }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(batchUpdatePath(input.spreadsheet), {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: input.title } } }] }),
      })),
    }),
    solusTool({
      name: 'delete_sheet',
      description: 'Delete a sheet and all its cells from a spreadsheet.',
      input: z.object({ spreadsheet, sheetId: z.number().int().min(0).describe('The sheetId from get_spreadsheet, not the sheet name.') }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        await vendorJson(await fetch(batchUpdatePath(input.spreadsheet), {
          method: 'POST',
          body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: input.sheetId } }] }),
        }))
        return { deleted: input.sheetId }
      },
    }),
  ],
})
