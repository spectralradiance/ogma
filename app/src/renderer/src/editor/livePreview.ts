import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, Facet, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

import { dirname, localFileUrl, resolvePath } from '../../../shared/paths'
import { notesMarkersCollapse } from './notesBlocks'
import { TableWidget } from './tableWidget'

/**
 * Typora-style live rendering.
 *
 * Markdown syntax is hidden everywhere except in the element the cursor touches:
 * inline marks reveal when the cursor is inside that span, line markers (#, >,
 * list bullets) when the cursor is on that line, and fences/tables when it is
 * inside the block. The document text itself is never changed.
 */

/** Absolute path of the open file, used to resolve relative image links. */
export const documentPath = Facet.define<string, string>({ combine: (values) => values[0] ?? '' })

export interface Span {
  from: number
  to: number
}

function touches(spans: readonly Span[], from: number, to: number): boolean {
  return spans.some((span) => span.from <= to && span.to >= from)
}

function touchesLines(state: EditorState, spans: readonly Span[], from: number, to: number): boolean {
  return touches(spans, state.doc.lineAt(from).from, state.doc.lineAt(to).to)
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement('span')
    bullet.className = 'cm-md-bullet'
    bullet.textContent = '•'
    return bullet
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'cm-md-hr'
    return rule
  }
}

class FenceLabelWidget extends WidgetType {
  readonly info: string

  constructor(info: string) {
    super()
    this.info = info
  }

  eq(other: FenceLabelWidget): boolean {
    return other.info === this.info
  }

  toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = 'cm-md-fence-label'
    label.textContent = this.info
    return label
  }
}

class CheckboxWidget extends WidgetType {
  readonly checked: boolean

  constructor(checked: boolean) {
    super()
    this.checked = checked
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-md-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Mark task not done' : 'Mark task done')
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const position = view.posAtDOM(box)
      const marker = view.state.doc.sliceString(position, position + 3)
      if (!/^\[[ xX]\]$/.test(marker)) return
      view.dispatch({ changes: { from: position + 1, to: position + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
}

class ImageWidget extends WidgetType {
  readonly src: string
  readonly alt: string

  constructor(src: string, alt: string) {
    super()
    this.src = src
    this.alt = alt
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    // The root element must never be replaced after rendering: CodeMirror would
    // read the swapped-in node as typed text. Only its children change.
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-md-image-wrap'
    const showBroken = () => {
      const placeholder = document.createElement('span')
      placeholder.className = 'cm-md-image-broken'
      placeholder.textContent = this.alt ? `Image not found: ${this.alt}` : 'Image not found'
      wrapper.replaceChildren(placeholder)
    }
    if (!this.src) {
      showBroken()
      return wrapper
    }
    const image = document.createElement('img')
    image.className = 'cm-md-image'
    image.src = this.src
    image.alt = this.alt
    image.addEventListener('error', showBroken)
    wrapper.append(image)
    return wrapper
  }
}

const bullet = new BulletWidget()
const rule = new RuleWidget()
const hidden = Decoration.replace({})

/** Maps a Markdown image target to something the renderer may load. */
export function imageSource(raw: string, documentDirectory: string): string {
  const target = raw.trim().replace(/^<(.*)>$/, '$1')
  if (/^(https:|data:image\/)/i.test(target)) return target
  const windowsDrivePath = /^[a-z]:[\\/]/i.test(target)
  if (!windowsDrivePath && /^[a-z][a-z0-9+.-]*:/i.test(target)) return '' // file:, javascript:, http: …
  if (!documentDirectory) return ''
  let decoded = target
  try {
    decoded = decodeURI(target)
  } catch {
    // keep the raw target
  }
  return localFileUrl(resolvePath(documentDirectory, decoded))
}

/** A table is shown as a widget unless the selection is inside it (block widgets must span whole lines). */
export function tableCollapses(state: EditorState, node: { from: number; to: number }): boolean {
  const first = state.doc.lineAt(node.from)
  const last = state.doc.lineAt(node.to)
  return first.from === node.from && last.to === node.to && !touches(state.selection.ranges, node.from, node.to)
}

const LEAF_BLOCKS = new Set([
  'Paragraph', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HorizontalRule', 'LinkReference', 'CommentBlock',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
])

function buildTableDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        if (tableCollapses(state, node)) {
          const widget = new TableWidget(state.doc.sliceString(node.from, node.to))
          decorations.push(Decoration.replace({ widget, block: true }).range(node.from, node.to))
        }
        return false
      }
      return !LEAF_BLOCKS.has(node.name)
    },
  })
  return Decoration.set(decorations)
}

const tableField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(value, transaction) {
    const reparsed = syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    return transaction.docChanged || transaction.selection || reparsed ? buildTableDecorations(transaction.state) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Builds the inline and line decorations. `active` holds the spans the cursor
 * reveals (empty when the editor is not focused); `ranges` limits work to what
 * is visible.
 */
export function buildLiveDecorations(
  state: EditorState,
  active: readonly Span[],
  ranges: readonly Span[] = [{ from: 0, to: state.doc.length }],
): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const doc = state.doc
  const documentDirectory = dirname(state.facet(documentPath))

  const lineClass = (position: number, className: string) => {
    decorations.push(Decoration.line({ class: className }).range(doc.lineAt(position).from))
  }
  const eachLine = (from: number, to: number, className: string) => {
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number += 1) {
      decorations.push(Decoration.line({ class: className }).range(doc.line(number).from))
    }
  }
  const hide = (from: number, to: number) => {
    if (to > from) decorations.push(hidden.range(from, to))
  }
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (to > from) decorations.push(Decoration.mark({ class: className, attributes }).range(from, to))
  }
  const replace = (from: number, to: number, widget: WidgetType) => {
    decorations.push(Decoration.replace({ widget }).range(from, to))
  }
  /** End of a marker plus the single space that follows it, if any. */
  const withSpace = (to: number, limit: number) => (to < limit && doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)

  const heading = (node: SyntaxNode, level: string) => {
    lineClass(node.from, `cm-md-heading cm-md-h${level}`)
    if (touchesLines(state, active, node.from, node.to)) return
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'HeaderMark') continue
      if (child.from === node.from) {
        hide(child.from, withSpace(child.to, node.to))
      } else {
        let start = child.from
        while (start > node.from && doc.sliceString(start - 1, start) === ' ') start -= 1
        hide(start, child.to)
      }
    }
  }

  const setextHeading = (node: SyntaxNode, level: string) => {
    const underline = node.getChild('HeaderMark')
    const textEnd = underline ? Math.max(node.from, underline.from - 1) : node.to
    eachLine(node.from, textEnd, `cm-md-heading cm-md-h${level}`)
    if (!underline) return
    lineClass(underline.from, 'cm-md-setext-mark')
    if (!touchesLines(state, active, node.from, node.to)) hide(underline.from, underline.to)
  }

  const codeBlock = (node: SyntaxNode) => {
    const first = doc.lineAt(node.from)
    const last = doc.lineAt(node.to)
    const revealed = touchesLines(state, active, node.from, node.to)
    for (let number = first.number; number <= last.number; number += 1) {
      const classes = ['cm-md-codeblock']
      if (number === first.number) classes.push('cm-md-codeblock-begin')
      if (number === last.number) classes.push('cm-md-codeblock-end')
      decorations.push(Decoration.line({ class: classes.join(' ') }).range(doc.line(number).from))
    }
    if (node.name !== 'FencedCode' || revealed) return
    const marks = node.getChildren('CodeMark')
    const info = node.getChild('CodeInfo')
    if (marks[0]) {
      lineClass(first.from, 'cm-md-fence')
      replace(first.from, first.to, new FenceLabelWidget(info ? doc.sliceString(info.from, info.to) : ''))
    }
    if (marks.length > 1 && last.number !== first.number) {
      lineClass(last.from, 'cm-md-fence')
      hide(last.from, last.to)
    }
  }

  const link = (node: SyntaxNode) => {
    const url = node.getChild('URL')
    const href = url ? doc.sliceString(url.from, url.to) : ''
    const attributes = href ? { 'data-href': href } : undefined
    const revealed = touches(active, node.from, node.to)
    const marks = node.getChildren('LinkMark')

    if (node.name === 'Autolink') {
      mark(node.from, node.to, 'cm-md-link', attributes)
      if (!revealed) for (const linkMark of marks) hide(linkMark.from, linkMark.to)
      return
    }
    // A bare [text] without a target is just bracketed prose.
    if (marks.length < 2 || (!url && !node.getChild('LinkLabel'))) return
    const textFrom = marks[0].to
    const textTo = marks[1].from
    mark(textFrom, textTo, 'cm-md-link', attributes)
    if (revealed) {
      if (url) mark(url.from, url.to, 'cm-md-url')
    } else {
      hide(node.from, textFrom)
      hide(textTo, node.to)
    }
  }

  const image = (node: SyntaxNode) => {
    if (touches(active, node.from, node.to) || doc.lineAt(node.from).number !== doc.lineAt(node.to).number) {
      mark(node.from, node.to, 'cm-md-image-source')
      return
    }
    const url = node.getChild('URL')
    const marks = node.getChildren('LinkMark')
    const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
    replace(node.from, node.to, new ImageWidget(url ? imageSource(doc.sliceString(url.from, url.to), documentDirectory) : '', alt))
  }

  const listMark = (node: SyntaxNode) => {
    const item = node.parent
    if (!item || touchesLines(state, active, node.from, node.to)) {
      mark(node.from, node.to, 'cm-md-listmark')
      return
    }
    if (item.getChild('Task')) {
      hide(node.from, withSpace(node.to, item.to))
    } else if (item.parent?.name === 'BulletList') {
      replace(node.from, node.to, bullet)
    } else {
      mark(node.from, node.to, 'cm-md-listmark')
    }
  }

  const tree = syntaxTree(state)
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        const node = ref.node
        const atx = /^ATXHeading(\d)$/.exec(ref.name)
        if (atx) {
          heading(node, atx[1])
          return
        }
        const setext = /^SetextHeading(\d)$/.exec(ref.name)
        if (setext) {
          setextHeading(node, setext[1])
          return
        }

        switch (ref.name) {
          case 'Emphasis':
            mark(ref.from, ref.to, 'cm-md-em')
            break
          case 'StrongEmphasis':
            mark(ref.from, ref.to, 'cm-md-strong')
            break
          case 'Strikethrough':
            mark(ref.from, ref.to, 'cm-md-strike')
            break
          case 'InlineCode':
            mark(ref.from, ref.to, 'cm-md-code')
            break
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const parent = node.parent
            if (parent && !touches(active, parent.from, parent.to)) hide(ref.from, ref.to)
            break
          }
          case 'CodeMark': {
            const parent = node.parent
            if (parent?.name === 'InlineCode' && !touches(active, parent.from, parent.to)) hide(ref.from, ref.to)
            break
          }
          case 'Escape':
            if (!touches(active, ref.from, ref.to)) hide(ref.from, ref.from + 1)
            break
          case 'Blockquote':
            eachLine(ref.from, ref.to, 'cm-md-blockquote')
            break
          case 'QuoteMark':
            if (!touchesLines(state, active, ref.from, ref.to)) hide(ref.from, withSpace(ref.to, doc.lineAt(ref.from).to))
            break
          case 'ListMark':
            listMark(node)
            break
          case 'TaskMarker': {
            const checked = /x/i.test(doc.sliceString(ref.from, ref.to))
            if (!touches(active, ref.from, ref.to)) replace(ref.from, ref.to, new CheckboxWidget(checked))
            if (checked && node.parent) mark(withSpace(ref.to, node.parent.to), node.parent.to, 'cm-md-task-done')
            break
          }
          case 'HorizontalRule':
            lineClass(ref.from, 'cm-md-hr-line')
            if (!touchesLines(state, active, ref.from, ref.to)) replace(ref.from, ref.to, rule)
            return false
          case 'FencedCode':
          case 'CodeBlock':
            codeBlock(node)
            return false
          case 'Link':
          case 'Autolink':
            link(node)
            break
          case 'Image':
            image(node)
            return false
          case 'URL': {
            const parent = node.parent?.name
            if (parent !== 'Link' && parent !== 'Image' && parent !== 'Autolink' && parent !== 'LinkReference') {
              mark(ref.from, ref.to, 'cm-md-link', { 'data-href': doc.sliceString(ref.from, ref.to) })
            }
            break
          }
          case 'Table':
            if (tableCollapses(state, ref)) return false
            eachLine(ref.from, ref.to, 'cm-md-table-source')
            break
          case 'HTMLTag':
          case 'Comment':
          case 'CommentBlock':
            mark(ref.from, ref.to, 'cm-md-html')
            break
        }
        return undefined
      },
    })
  }
  return Decoration.set(decorations, true)
}

function activeSpans(view: EditorView): Span[] {
  return view.hasFocus ? view.state.selection.ranges.map(({ from, to }) => ({ from, to })) : []
}

const livePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildLiveDecorations(view.state, activeSpans(view), view.visibleRanges)
    }

    update(update: ViewUpdate) {
      const reparsed = syntaxTree(update.startState) !== syntaxTree(update.state)
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || reparsed) {
        this.decorations = buildLiveDecorations(update.state, activeSpans(update.view), update.view.visibleRanges)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** Ctrl/Cmd+click follows a rendered link. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(event) {
    if (!(event.ctrlKey || event.metaKey)) return false
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-href]')
    const href = target?.dataset.href
    if (!href || !/^https?:\/\//i.test(href)) return false
    event.preventDefault()
    window.open(href, '_blank')
    return true
  },
})

export const livePreview: Extension = [
  livePlugin, tableField, linkClicks, notesMarkersCollapse.of(true), EditorView.editorAttributes.of({ class: 'cm-live' }),
]
