/** Local, deterministic text measurements shown next to the AI's qualitative analysis. */

export interface TextMetrics {
  words: number
  sentences: number
  paragraphs: number
  averageSentenceWords: number
  /** Standard deviation of sentence length in words: low means monotonous rhythm. */
  sentenceSpread: number
  longSentences: number
  /** Flesch reading ease: 60–70 is plain English; higher is easier. */
  readingEase: number
  /** Flesch–Kincaid grade level. */
  gradeLevel: number
  /** Content words used three or more times, most frequent first. */
  repeated: { word: string; count: number }[]
}

const LONG_SENTENCE_WORDS = 30

export const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it
its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than
that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who
whom why will with would you your yours yourself yourselves one also may might must shall us it's that's there's`.split(/\s+/))

/** Strips Markdown syntax that should not count as words. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '')
    .replace(/[*_~]+/g, '')
}

export function syllables(word: string): number {
  const letters = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!letters) return 0
  if (letters.length <= 3) return 1
  const trimmed = letters.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  return Math.max(1, trimmed.match(/[aeiouy]{1,2}/g)?.length ?? 1)
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places

export function measureText(markdown: string): TextMetrics {
  const text = plainText(markdown)
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
  // Each non-empty line of a list or paragraph ends at most one sentence group.
  const sentenceTexts = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])["”’)]*\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
  const sentenceWords = sentenceTexts.map((sentence) => sentence.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [])
  const allWords = sentenceWords.flat()
  const words = allWords.length
  const sentences = Math.max(1, sentenceTexts.length)
  const lengths = sentenceWords.map((list) => list.length)
  const average = words / sentences
  const variance = lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / sentences
  const syllableCount = allWords.reduce((sum, word) => sum + syllables(word), 0)
  const perWord = words === 0 ? 0 : syllableCount / words

  const counts = new Map<string, number>()
  for (const word of allWords) {
    const key = word.toLocaleLowerCase()
    if (key.length > 2 && !STOPWORDS.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([word, count]) => ({ word, count }))

  return {
    words,
    sentences: sentenceTexts.length,
    paragraphs: paragraphs.length,
    averageSentenceWords: round(average),
    sentenceSpread: round(Math.sqrt(variance)),
    longSentences: lengths.filter((length) => length > LONG_SENTENCE_WORDS).length,
    readingEase: words === 0 ? 0 : round(206.835 - 1.015 * average - 84.6 * perWord),
    gradeLevel: words === 0 ? 0 : round(0.39 * average + 11.8 * perWord - 15.59),
    repeated,
  }
}

export function describeMetrics(metrics: TextMetrics): string {
  const repeated = metrics.repeated.length
    ? `; repeated words: ${metrics.repeated.map((item) => `${item.word} ×${item.count}`).join(', ')}`
    : ''
  return `${metrics.words} words, ${metrics.sentences} sentences, ${metrics.paragraphs} paragraphs; `
    + `average sentence ${metrics.averageSentenceWords} words (spread ${metrics.sentenceSpread}), `
    + `${metrics.longSentences} over ${LONG_SENTENCE_WORDS} words; Flesch reading ease ${metrics.readingEase}, `
    + `grade level ${metrics.gradeLevel}${repeated}`
}
