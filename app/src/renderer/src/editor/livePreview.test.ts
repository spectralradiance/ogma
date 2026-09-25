import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { localFileUrl } from '../../../shared/paths'
import { toggleWrap } from './commands'
import { focusedBlock } from './focusMode'
import { buildLiveDecorations, documentPath, imageSource, tableCollapses } from './livePreview'
import { parseTable, splitRow } from './tableWidget'

function stateFor(doc: string, cursor?: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: cursor === undefined ? undefined : { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage }), documentPath.of('C:\\notes\\poems\\a.md')],
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state
}

interface Rendered {
  hidden: string[]
  widgets: string[]
  marks: string[]
  lines: string[]
}

/** Summarizes decorations as readable strings; `cursor` is where the (focused) cursor sits. */
function render(doc: string, cursor?: number): Rendered {
  const state = stateFor(doc, cursor)
  const active = cursor === undefined ? [] : [{ from: cursor, to: cursor }]
  const result: Rendered = { hidden: [], widgets: [], marks: [], lines: [] }
  buildLiveDecorations(state, active).between(0, doc.length, (from, to, value) => {
    const spec = value.spec as { widget?: object; class?: string; attributes?: Record<string, string> }
    const text = doc.slice(from, to)
    if (spec.widget) result.widgets.push(`${spec.widget.constructor.name}:${text}`)
    else if (from === to && spec.class) result.lines.push(`${state.doc.lineAt(from).number}:${spec.class}`)
    else if (spec.class) result.marks.push(`${spec.class}:${text}${spec.attributes?.['data-href'] ? `→${spec.attributes['data-href']}` : ''}`)
    else result.hidden.push(text)
  })
  return result
}

describe('headings', () => {
  it('hide the # marker unless the cursor is on the heading line', () => {
    expect(render('# Title\n\ntext', 12)).toMatchObject({ hidden: ['# '], lines: ['1:cm-md-heading cm-md-h1'] })
    expect(render('# Title\n\ntext', 3).hidden).toEqual([])
  })

  it('hide closing hashes too', () => {
    expect(render('## Title ##\n\nx', 14).hidden).toEqual(['## ', ' ##'])
  })

  it('treat an unfocused editor as having no cursor', () => {
    expect(render('# Title').hidden).toEqual(['# '])
  })
})

describe('inline marks', () => {
  const doc = 'some **bold** and *em* and `code` and ~~gone~~'

  it('hide markers of spans the cursor is not in', () => {
    const { hidden, marks } = render(doc, 0)
    expect(hidden).toEqual(['**', '**', '*', '*', '`', '`', '~~', '~~'])
    expect(marks).toEqual(['cm-md-strong:**bold**', 'cm-md-em:*em*', 'cm-md-code:`code`', 'cm-md-strike:~~gone~~'])
  })

  it('reveal only the span under the cursor', () => {
    expect(render(doc, 8).hidden).toEqual(['*', '*', '`', '`', '~~', '~~'])
  })

  it('hide escape backslashes', () => {
    expect(render('a \\* b', 0).hidden).toEqual(['\\'])
  })
})

describe('links', () => {
  it('show only the link text, carrying the target for ctrl+click', () => {
    const { hidden, marks } = render('see [the site](https://example.org "t") now', 0)
    expect(hidden).toEqual(['[', '](https://example.org "t")'])
    expect(marks).toContain('cm-md-link:the site→https://example.org')
  })

  it('show the source with the URL dimmed when the cursor is inside', () => {
    const { hidden, marks } = render('see [site](https://example.org) now', 6)
    expect(hidden).toEqual([])
    expect(marks).toContain('cm-md-url:https://example.org')
  })

  it('leave bare [brackets] alone', () => {
    expect(render('a [note] here', 0)).toMatchObject({ hidden: [], marks: [] })
  })

  it('style bare URLs as links', () => {
    expect(render('go to https://example.org today', 0).marks).toEqual(['cm-md-link:https://example.org→https://example.org'])
  })
})

describe('lists and tasks', () => {
  it('render bullets unless the cursor is on the line', () => {
    expect(render('- one\n- two', 9).widgets).toEqual(['BulletWidget:-'])
    expect(render('- one\n- two', 9).marks).toEqual(['cm-md-listmark:-'])
  })

  it('keep ordered list numbers', () => {
    expect(render('1. one', undefined).marks).toEqual(['cm-md-listmark:1.'])
  })

  it('render task markers as checkboxes and strike done items', () => {
    const { hidden, widgets, marks } = render('- [x] done\n- [ ] todo')
    expect(hidden).toEqual(['- ', '- '])
    expect(widgets).toEqual(['CheckboxWidget:[x]', 'CheckboxWidget:[ ]'])
    expect(marks).toEqual(['cm-md-task-done:done'])
  })
})

describe('blocks', () => {
  it('hide quote markers and style quoted lines', () => {
    const { hidden, lines } = render('> quoted\n> more\n\nafter', 20)
    expect(hidden).toEqual(['> ', '> '])
    expect(lines).toEqual(['1:cm-md-blockquote', '2:cm-md-blockquote'])
  })

  it('collapse code fences to a language label outside the block', () => {
    const doc = '```js\nlet a = 1\n```\n\nafter'
    const outside = render(doc, doc.length)
    expect(outside.widgets).toEqual(['FenceLabelWidget:```js'])
    expect(outside.hidden).toEqual(['```'])
    const inside = render(doc, 8)
    expect(inside.widgets).toEqual([])
    expect(inside.hidden).toEqual([])
  })

  it('draw horizontal rules', () => {
    expect(render('a\n\n---\n\nb', 0).widgets).toEqual(['RuleWidget:---'])
  })

  it('render images from paths relative to the document', () => {
    const doc = '![moon](img/moon.png)\n\nx'
    const { widgets } = render(doc, doc.length)
    expect(widgets).toEqual(['ImageWidget:![moon](img/moon.png)'])
  })
})

describe('imageSource', () => {
  it('resolves local paths through the workspace protocol and blocks other schemes', () => {
    expect(imageSource('img/moon.png', 'C:\\notes')).toBe(localFileUrl('C:\\notes\\img\\moon.png'))
    expect(imageSource('my%20pic.png', 'C:\\notes')).toBe(localFileUrl('C:\\notes\\my pic.png'))
    expect(imageSource('D:\\pics\\a.png', 'C:\\notes')).toBe(localFileUrl('D:\\pics\\a.png'))
    expect(imageSource('https://example.org/a.png', 'C:\\notes')).toBe('https://example.org/a.png')
    expect(imageSource('file:///C:/secret.png', 'C:\\notes')).toBe('')
    expect(imageSource('javascript:alert(1)', 'C:\\notes')).toBe('')
    expect(imageSource('a.png', '')).toBe('')
  })
})

describe('tables', () => {
  const table = '| Name | Era |\n| :--- | ---: |\n| `a|b` | 1 |\n| x \\| y | 2 |'

  it('collapse to a widget only when the selection is outside', () => {
    const doc = `${table}\n\nafter`
    const outside = stateFor(doc, doc.length)
    ensureSyntaxTree(outside, doc.length, 5000)
    expect(tableCollapses(outside, { from: 0, to: table.length })).toBe(true)
    expect(tableCollapses(stateFor(doc, 3), { from: 0, to: table.length })).toBe(false)
  })

  it('parse cells, alignment, escaped pipes and pipes inside code', () => {
    expect(parseTable(table)).toEqual({
      header: ['Name', 'Era'],
      alignments: ['left', 'right'],
      rows: [['`a|b`', '1'], ['x | y', '2']],
    })
    expect(splitRow('no | outer | pipes')).toEqual(['no', 'outer', 'pipes'])
  })
})

describe('focusedBlock', () => {
  it('is the paragraph around the cursor, or the line between blocks', () => {
    const doc = 'first para\nstill first\n\nsecond'
    expect(focusedBlock(stateFor(doc, 3))).toEqual({ from: 0, to: 22 })
    expect(focusedBlock(stateFor(doc, 23))).toEqual({ from: 23, to: 23 })
  })
})

describe('toggleWrap', () => {
  function apply(doc: string, from: number, to: number, marker: string): string {
    let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) })
    toggleWrap(marker)({ state, dispatch: (transaction) => { state = transaction.state } })
    return `${state.doc}|${state.sliceDoc(state.selection.main.from, state.selection.main.to)}`
  }

  it('wraps and unwraps the selection', () => {
    expect(apply('make bold', 5, 9, '**')).toBe('make **bold**|bold')
    expect(apply('make **bold**', 7, 11, '**')).toBe('make bold|bold')
    expect(apply('ab', 1, 1, '*')).toBe('a**b|')
  })
})
