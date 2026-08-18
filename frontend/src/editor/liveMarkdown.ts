import type { Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'


const inlineMarkdown = /(\*\*|~~|`|\*)([^\n]+?)\1/g

function liveDecorations(view: EditorView): DecorationSet {
  const decorations = []
  const activeLine = view.state.doc.lineAt(view.state.selection.main.head).number

  for (const range of view.visibleRanges) {
    let position = range.from
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position)
      if (line.number !== activeLine) {
        const heading = /^(#{1,6})\s+/.exec(line.text)
        let inlineStart = 0
        if (heading) {
          inlineStart = heading[0].length
          decorations.push(Decoration.replace({}).range(line.from, line.from + inlineStart))
          decorations.push(Decoration.line({ class: `cm-live-heading cm-live-h${heading[1].length}` }).range(line.from))
        } else if (line.text.startsWith('> ')) {
          inlineStart = 2
          decorations.push(Decoration.replace({}).range(line.from, line.from + inlineStart))
          decorations.push(Decoration.line({ class: 'cm-live-blockquote' }).range(line.from))
        }

        inlineMarkdown.lastIndex = inlineStart
        for (let match = inlineMarkdown.exec(line.text); match; match = inlineMarkdown.exec(line.text)) {
          const marker = match[1]
          const contentFrom = line.from + match.index + marker.length
          const contentTo = line.from + match.index + match[0].length - marker.length
          if (contentFrom >= contentTo) continue
          const className = marker === '**'
            ? 'cm-live-strong'
            : marker === '*'
              ? 'cm-live-emphasis'
              : marker === '~~'
                ? 'cm-live-strike'
                : 'cm-live-code'
          decorations.push(Decoration.replace({}).range(line.from + match.index, contentFrom))
          decorations.push(Decoration.mark({ class: className }).range(contentFrom, contentTo))
          decorations.push(Decoration.replace({}).range(contentTo, line.from + match.index + match[0].length))
        }
      }
      if (line.to >= range.to) break
      position = line.to + 1
    }
  }
  return Decoration.set(decorations, true)
}

const liveMarkdownPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = liveDecorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = liveDecorations(update.view)
    }
  }
}, { decorations: (value) => value.decorations })

export const liveMarkdown: Extension = [
  liveMarkdownPlugin,
  EditorView.theme({
    '.cm-live-heading': { fontFamily: '"Source Serif 4", serif', fontWeight: '600', color: '#17231f' },
    '.cm-live-h1': { fontSize: '1.75em', lineHeight: '1.55' },
    '.cm-live-h2': { fontSize: '1.4em', lineHeight: '1.55', borderBottom: '1px solid #d4dad4' },
    '.cm-live-h3': { fontSize: '1.18em', lineHeight: '1.5' },
    '.cm-live-h4, .cm-live-h5, .cm-live-h6': { fontSize: '1.05em', lineHeight: '1.45' },
    '.cm-live-strong': { fontWeight: '700' },
    '.cm-live-emphasis': { fontStyle: 'italic' },
    '.cm-live-strike': { textDecoration: 'line-through', color: '#6c7772' },
    '.cm-live-code': { fontFamily: '"IBM Plex Mono", Consolas, monospace', backgroundColor: '#e8ede8', borderRadius: '3px', padding: '1px 3px' },
    '.cm-live-blockquote': { borderLeft: '3px solid #92ad9f', paddingLeft: '16px !important', color: '#6c7772', fontStyle: 'italic' },
  }),
]