// Locating a quote is fuzzy on purpose (case, punctuation, line breaks and ligatures are ignored), so
// "p<.001" and "p>.001" fold to the same letters. The tokens that carry a result — numbers, decimals,
// percentages, signs and comparison operators, statistic symbols — are compared exactly here, after
// normalising only the ways PDF text extraction spells the same character differently. A difference is
// reported, never smoothed over: a located passage is not a confirmed one.

/** Spell the same character one way: compatibility forms, minus/dash variants, two-character operators. */
export function normalizeSignificant(text: string): string {
  return (
    text
      .normalize('NFKC')
      .replace(/\u00ad/g, '')
      // LaTeX sets the math minus in its own font, so pdf.js gives it as a separate item: "− 2.10".
      // U+2212 is always a minus; join it to its number before dashes are folded together.
      .replace(/\u2212\s+(?=\.?\d)/g, '\u2212')
      // Hyphen, non-breaking hyphen, figure dash, en dash and the minus sign all reach us as minus.
      .replace(/[\u2010-\u2013\u2212\ufe63\uff0d]/g, '-')
      .replace(/[\u2266\u2a7d]|<=/g, '\u2264')
      .replace(/[\u2267\u2a7e]|>=/g, '\u2265')
      .replace(/!=|=\/=/g, '\u2260')
      .replace(/\+\/-|\+-(?=\s*\d)/g, '\u00b1')
      // A spaced minus after an operator or opening bracket ("r = - .32", "[- 0.1") is a sign; a spaced
      // dash between two numbers ("18 - 25") stays a range.
      .replace(/(^\s*|[=<>\u2264\u2265\u2260\u00b1(\[,;:]\s*)-\s+(?=\.?\d)/g, '$1-')
      // Extraction often breaks a number around its point or before its percent sign.
      .replace(/(\d|[<>=≤≥≠(]\s*|^)\.\s+(\d)/g, '$1.$2')
      .replace(/(\d)\s+%/g, '$1%')
  )
}

// A minus counts as a sign only where it cannot be a hyphen or a range dash ("t-test", "18-25").
const TOKEN = /(?:(?<![\p{L}\p{N}.])-)?(?:\d+(?:[.,]\d+)*|\.\d+)(?:[eE][-+]?\d+)?%?|[<>=≤≥≠±×]|\p{Script=Greek}/gu

/** The tokens of a text that must match exactly, in order. */
export function significantTokens(text: string): string[] {
  return normalizeSignificant(text).match(TOKEN) ?? []
}

export type TokenPart = { t: string; changed: boolean }
export type TokenDiff = { quote: TokenPart[]; source: TokenPart[] }

/** The significant tokens of the quote against those of the located source text; null when they agree. */
export function compareSignificant(quote: string, source: string): TokenDiff | null {
  return diffTokens(significantTokens(quote), significantTokens(source))
}

export function diffTokens(a: string[], b: string[]): TokenDiff | null {
  if (a.length === b.length && a.every((t, i) => t === b[i])) return null
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const quote: TokenPart[] = [],
    source: TokenPart[] = []
  let i = 0,
    j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      quote.push({ t: a[i++], changed: false })
      source.push({ t: b[j++], changed: false })
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) source.push({ t: b[j++], changed: true })
    else quote.push({ t: a[i++], changed: true })
  }
  return { quote, source }
}

/** Merge the per-passage differences of an abbreviated ("…") quote into one. */
export function mergeDiffs(diffs: (TokenDiff | null)[], tokens: { quote: string[]; source: string[] }[]): TokenDiff | null {
  if (diffs.every((d) => !d)) return null
  return {
    quote: diffs.flatMap((d, k) => d?.quote ?? tokens[k].quote.map((t) => ({ t, changed: false }))),
    source: diffs.flatMap((d, k) => d?.source ?? tokens[k].source.map((t) => ({ t, changed: false }))),
  }
}
