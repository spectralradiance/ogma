/**
 * Splits Wiktionary etymology text into its parts. Many entries begin with an
 * "Etymology tree" block — one "Language term" line per ancestor, oldest first,
 * ending at the word itself — followed by prose and sometimes "Cognates".
 */

export interface EtymologyStep {
  language: string
  term: string
}

export interface Etymology {
  tree: EtymologyStep[]
  prose: string
  cognates: string | null
}

// Template labels that leak into the tree lines, e.g. "Latin nucleuslbor." (learned borrowing).
const TREE_LABEL = /(?:lbor|ubor|obor|bor|inh|der|calque)\.$/

function isTreeLine(line: string): boolean {
  return line.length > 0 && line.length <= 70 && !/[,;(“”]/.test(line) && !/\.\s/.test(line) && / /.test(line)
}

export function parseTreeLine(line: string): EtymologyStep {
  const cleaned = line.trim().replace(TREE_LABEL, '')
  const space = cleaned.lastIndexOf(' ')
  return space < 0
    ? { language: '', term: cleaned }
    : { language: cleaned.slice(0, space), term: cleaned.slice(space + 1) }
}

export function parseEtymology(text: string | null, word = ''): Etymology {
  if (!text) return { tree: [], prose: '', cognates: null }
  let lines = text.split('\n')
  const tree: EtymologyStep[] = []

  if (lines[0]?.trim() === 'Etymology tree') {
    let index = 1
    const target = `english ${word}`.toLocaleLowerCase()
    while (index < lines.length && isTreeLine(lines[index])) {
      const line = lines[index]
      tree.push(parseTreeLine(line))
      index += 1
      if (word && line.replace(TREE_LABEL, '').trim().toLocaleLowerCase() === target) break
    }
    lines = lines.slice(index)
  }

  const cognatesAt = lines.findIndex((line) => line.trim() === 'Cognates')
  const prose = (cognatesAt < 0 ? lines : lines.slice(0, cognatesAt)).join('\n').trim()
  const cognates = cognatesAt < 0 ? null : lines.slice(cognatesAt + 1).join('\n').trim() || null
  return { tree, prose, cognates }
}
