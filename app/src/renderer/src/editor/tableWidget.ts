import { EditorView, WidgetType } from '@codemirror/view'

export type Alignment = 'left' | 'center' | 'right' | null

export interface ParsedTable {
  header: string[]
  alignments: Alignment[]
  rows: string[][]
}

/** Splits a GFM table row on unescaped pipes outside inline code. */
export function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
    } else if (char === '`') {
      inCode = !inCode
      current += char
    } else if (char === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function alignment(cell: string): Alignment {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

export function parseTable(source: string): ParsedTable {
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  const header = splitRow(lines[0] ?? '')
  const alignments = splitRow(lines[1] ?? '').map(alignment)
  const rows = lines.slice(2).map(splitRow)
  return { header, alignments, rows }
}

/** Minimal inline rendering for cells: strong, emphasis, code and strikethrough. */
function renderInline(text: string, parent: HTMLElement): void {
  const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|~~[^~]+~~)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(last, match.index))
    const token = match[0]
    const element = token.startsWith('**')
      ? Object.assign(document.createElement('strong'), { textContent: token.slice(2, -2) })
      : token.startsWith('`')
        ? Object.assign(document.createElement('code'), { textContent: token.slice(1, -1) })
        : token.startsWith('~~')
          ? Object.assign(document.createElement('s'), { textContent: token.slice(2, -2) })
          : Object.assign(document.createElement('em'), { textContent: token.slice(1, -1) })
    parent.append(element)
    last = match.index + token.length
  }
  parent.append(text.slice(last))
}

export class TableWidget extends WidgetType {
  readonly source: string

  constructor(source: string) {
    super()
    this.source = source
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(view: EditorView): HTMLElement {
    const { header, alignments, rows } = parseTable(this.source)
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-md-table-wrap'
    wrapper.title = 'Click to edit the table source'
    const table = document.createElement('table')
    table.className = 'cm-md-table'

    const addCell = (row: HTMLTableRowElement, tag: 'th' | 'td', text: string, column: number) => {
      const cell = document.createElement(tag)
      const align = alignments[column]
      if (align) cell.style.textAlign = align
      renderInline(text, cell)
      row.append(cell)
    }

    const head = table.createTHead().insertRow()
    header.forEach((text, column) => addCell(head, 'th', text, column))
    const body = table.createTBody()
    for (const cells of rows) {
      const row = body.insertRow()
      header.forEach((_, column) => addCell(row, 'td', cells[column] ?? '', column))
    }
    wrapper.append(table)

    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ selection: { anchor: view.posAtDOM(wrapper) } })
      view.focus()
    })
    return wrapper
  }

  ignoreEvent(): boolean {
    return true
  }
}
