import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/**
 * The block the cursor is in: the top-level block (or innermost list item)
 * containing it, or just the cursor's line when it sits between blocks.
 */
export function focusedBlock(state: EditorState): { from: number; to: number } {
  const head = state.selection.main.head
  const tree = syntaxTree(state)
  let node = tree.resolveInner(head, -1)
  if (node.name === 'Document') node = tree.resolveInner(head, 1)
  while (node.parent && node.parent.name !== 'Document' && node.name !== 'ListItem') node = node.parent
  if (node.name === 'Document') {
    const line = state.doc.lineAt(head)
    return { from: line.from, to: line.to }
  }
  return { from: node.from, to: node.to }
}

function dimOutsideFocus(view: EditorView): DecorationSet {
  const block = focusedBlock(view.state)
  const doc = view.state.doc
  const first = doc.lineAt(block.from).number
  const last = doc.lineAt(block.to).number
  const decorations: Range<Decoration>[] = []
  const dim = Decoration.line({ class: 'cm-focus-dim' })
  for (const { from, to } of view.visibleRanges) {
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number += 1) {
      if (number < first || number > last) decorations.push(dim.range(doc.line(number).from))
    }
  }
  return Decoration.set(decorations)
}

/** Typora-style focus mode: everything except the current block fades back. */
export const focusMode: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = dimOutsideFocus(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = dimOutsideFocus(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
