import { hoverTooltip } from '@codemirror/view'

import { api } from '../api'


const wordPattern = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu

function wordAt(line: string, offset: number) {
  for (const match of line.matchAll(wordPattern)) {
    const start = match.index
    const end = start + match[0].length
    if (offset >= start && offset <= end) return { word: match[0], start, end }
  }
  return null
}

function element(tag: string, className: string, text?: string) {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}

export const dictionaryHover = hoverTooltip(async (view, position) => {
  const line = view.state.doc.lineAt(position)
  const match = wordAt(line.text, position - line.from)
  if (!match || match.word.length < 2) return null

  try {
    const entries = await api.defineWord(match.word)
    const entry = entries[0]
    if (!entry) return null
    const gloss = entry.data.senses.flatMap((sense) => sense.glosses)[0] ?? 'No definition available'
    return {
      pos: line.from + match.start,
      end: line.from + match.end,
      above: true,
      create() {
        const dom = element('div', 'cm-dictionary-tooltip')
        const heading = element('div', 'dictionary-tooltip-heading')
        heading.append(element('strong', '', entry.word))
        if (entry.data.ipa[0]) heading.append(element('span', '', entry.data.ipa[0]))
        dom.append(heading)
        if (entry.pos) dom.append(element('div', 'dictionary-tooltip-pos', entry.pos))
        dom.append(element('p', '', gloss))
        return { dom }
      },
    }
  } catch {
    return null
  }
}, { hoverTime: 250 })