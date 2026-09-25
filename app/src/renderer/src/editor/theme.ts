import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

// Colors come from the CSS custom properties in styles.css, so light and dark
// mode follow the system theme without reconfiguring the editor.

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--syntax-mark)' },
  // Code inside fenced blocks
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-function)' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--code-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
])

const base = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': {
    maxWidth: '860px',
    margin: '0 auto',
    padding: '40px 32px 45vh',
    caretColor: 'var(--accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-selected)' },
  '.cm-focus-dim': { opacity: '0.3', transition: 'opacity 120ms' },
})

const live = EditorView.theme({
  '&.cm-live .cm-scroller': { fontFamily: 'var(--font-serif)', fontSize: '17px', lineHeight: '1.75' },
  '&.cm-live .cm-content': { maxWidth: '760px' },

  '.cm-md-heading': { fontWeight: '650', lineHeight: '1.3' },
  '.cm-md-h1': { fontSize: '2em', padding: '0.6em 0 0.25em !important' },
  '.cm-md-h2': { fontSize: '1.55em', padding: '0.55em 0 0.2em !important', borderBottom: '1px solid var(--border)' },
  '.cm-md-h3': { fontSize: '1.3em', padding: '0.5em 0 0.15em !important' },
  '.cm-md-h4': { fontSize: '1.12em', padding: '0.4em 0 0.1em !important' },
  '.cm-md-h5, .cm-md-h6': { fontSize: '1em', padding: '0.3em 0 0 !important', color: 'var(--muted)' },
  '.cm-md-setext-mark': { fontSize: '0.8em', color: 'var(--syntax-mark)' },

  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--muted)' },
  '.cm-md-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    backgroundColor: 'var(--surface)',
    borderRadius: '3px',
    padding: '0.1em 0.3em',
  },
  '.cm-md-link': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-md-url, .cm-md-image-source, .cm-md-html': { color: 'var(--syntax-mark)', fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
  '.cm-md-listmark': { color: 'var(--muted)' },
  '.cm-md-bullet': { display: 'inline-block', width: '1.1em', color: 'var(--muted)' },
  '.cm-md-checkbox': { margin: '0 0.45em 0 0', verticalAlign: 'middle', cursor: 'pointer', accentColor: 'var(--accent)' },
  '.cm-md-task-done': { color: 'var(--muted)', textDecoration: 'line-through' },

  '.cm-md-blockquote': {
    borderLeft: '3px solid var(--quote-bar)',
    paddingLeft: '1em !important',
    color: 'var(--muted)',
    fontStyle: 'italic',
  },

  '.cm-md-hr-line': { padding: '0.6em 0 !important' },
  '.cm-md-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--border)', verticalAlign: 'middle' },

  '.cm-md-codeblock': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.86em',
    lineHeight: '1.55',
    backgroundColor: 'var(--surface)',
    padding: '0 1em !important',
  },
  '.cm-md-codeblock-begin': { borderTopLeftRadius: '5px', borderTopRightRadius: '5px', paddingTop: '0.4em !important' },
  '.cm-md-codeblock-end': { borderBottomLeftRadius: '5px', borderBottomRightRadius: '5px', paddingBottom: '0.4em !important' },
  '.cm-md-fence': { fontSize: '0.72em', lineHeight: '1.4', color: 'var(--muted)', textAlign: 'right' },
  '.cm-md-fence-label': { fontFamily: 'var(--font-ui)', letterSpacing: '0.04em' },

  '.cm-md-image-wrap': { display: 'inline-block', maxWidth: '100%' },
  '.cm-md-image': { display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0.5em 0', borderRadius: '4px' },
  '.cm-md-image-broken': { color: 'var(--bad)', fontFamily: 'var(--font-ui)', fontSize: '0.85em' },

  '.cm-md-table-source': { fontFamily: 'var(--font-mono)', fontSize: '0.86em' },
  '.cm-md-table-wrap': { overflowX: 'auto', margin: '0.5em 0', cursor: 'text' },
  '.cm-md-table': { borderCollapse: 'collapse', fontSize: '0.95em', lineHeight: '1.5' },
  '.cm-md-table th, .cm-md-table td': { border: '1px solid var(--border)', padding: '0.3em 0.75em' },
  '.cm-md-table th': { backgroundColor: 'var(--surface)', fontWeight: '650' },
  '.cm-md-table code': { fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
})

export const editorTheme: Extension = [base, live, syntaxHighlighting(highlight)]

/** For editors stacked inside one scrolling document: no own scrollbar, no end padding. */
export const autoHeightTheme: Extension = EditorView.theme({
  '&': { height: 'auto' },
  '.cm-scroller': { overflow: 'visible' },
  '.cm-content, &.cm-live .cm-content': { maxWidth: 'none', padding: '6px 24px 14px' },
})
