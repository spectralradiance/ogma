import { hoverTooltip } from '@codemirror/view'

import { wordAt } from '../../../shared/text'

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}

/** Hovering a word shows its first definition from the local Wiktionary (from ogma's dictionaryHover). */
export const dictionaryHover = hoverTooltip(async (view, position) => {
  const line = view.state.doc.lineAt(position)
  const match = wordAt(line.text, position - line.from)
  if (!match || match.word.length < 3) return null
  try {
    const entries = await window.ogma.dictionary.lookup(match.word)
    const entry = entries.find((candidate) => candidate.senses.some((sense) => sense.glosses.length > 0))
    if (!entry) return null
    const gloss = entry.senses.flatMap((sense) => sense.glosses)[0]
    return {
      pos: line.from + match.from,
      end: line.from + match.to,
      above: true,
      create() {
        const dom = element('div', 'cm-dictionary-tooltip')
        const heading = element('div', 'cm-dictionary-heading')
        heading.append(element('strong', '', entry.word))
        if (entry.pos) heading.append(element('span', 'cm-dictionary-pos', entry.pos))
        if (entry.ipa[0]) heading.append(element('span', 'cm-dictionary-ipa', entry.ipa[0]))
        dom.append(heading, element('p', '', gloss))
        return { dom }
      },
    }
  } catch {
    return null // dictionary unavailable: no tooltip
  }
}, { hoverTime: 600 })
