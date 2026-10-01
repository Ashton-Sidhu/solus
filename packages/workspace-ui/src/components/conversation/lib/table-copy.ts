/**
 * A rendered reply table as text. The table renderer receives only its
 * children, not the markdown source, so the copy is read back from the cells.
 */

/** The cell text of each row, header row first. */
export function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map((row) => [...row.cells].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()))
}

export function rowsToMarkdown(rows: string[][]): string {
  const [header = [], ...body] = rows
  const width = Math.max(header.length, ...body.map((row) => row.length))
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => (row[index] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}

export function rowsToCsv(rows: string[][]): string {
  const field = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  return rows.map((row) => row.map(field).join(',')).join('\n')
}
