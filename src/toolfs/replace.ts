/**
 * Edit-tool replacement engine, ported from opencode's replacer chain (MIT).
 * Each replacer proposes candidate matches for `oldString`; the first
 * candidate that occurs exactly once (or `replaceAll`) wins. The chain runs
 * strictest first, so an exact match always beats a fuzzy one.
 */

type Replacer = (content: string, find: string) => Generator<string>

function* simple(_content: string, find: string): Generator<string> {
  yield find
}

/** Match ignoring leading/trailing whitespace per line. */
function* lineTrimmed(content: string, find: string): Generator<string> {
  const contentLines = content.split('\n')
  const findLines = find.split('\n')
  if (findLines.at(-1) === '') findLines.pop()
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    let matches = true
    for (let j = 0; j < findLines.length; j++) {
      if (contentLines[i + j]?.trim() !== findLines[j]?.trim()) {
        matches = false
        break
      }
    }
    if (!matches) continue
    let start = 0
    for (let k = 0; k < i; k++) start += (contentLines[k] as string).length + 1
    let end = start
    for (let k = 0; k < findLines.length; k++) {
      end += (contentLines[i + k] as string).length + 1
    }
    yield content.slice(start, end - 1)
  }
}

/** Match with all runs of whitespace collapsed. */
function* whitespaceNormalized(content: string, find: string): Generator<string> {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const target = normalize(find)
  const lines = content.split('\n')
  const findLineCount = find.split('\n').length
  for (let i = 0; i <= lines.length - findLineCount; i++) {
    const block = lines.slice(i, i + findLineCount).join('\n')
    if (normalize(block) === target) yield block
  }
}

/** Match with a uniform indentation shift applied to the whole block. */
function* indentationFlexible(content: string, find: string): Generator<string> {
  const removeIndent = (text: string): string => {
    const lines = text.split('\n')
    const nonEmpty = lines.filter(line => line.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const indent = Math.min(...nonEmpty.map(line => line.length - line.trimStart().length))
    return lines.map(line => (line.trim().length === 0 ? line : line.slice(indent))).join('\n')
  }
  const target = removeIndent(find)
  const lines = content.split('\n')
  const findLineCount = find.split('\n').length
  for (let i = 0; i <= lines.length - findLineCount; i++) {
    const block = lines.slice(i, i + findLineCount).join('\n')
    if (removeIndent(block) === target) yield block
  }
}

const REPLACERS: readonly Replacer[] = [simple, lineTrimmed, whitespaceNormalized, indentationFlexible]

function occurrences(content: string, search: string): number {
  if (search === '') return 0
  let count = 0
  let index = content.indexOf(search)
  while (index !== -1) {
    count++
    index = content.indexOf(search, index + search.length)
  }
  return count
}

/**
 * Replace `oldString` with `newString` in `content`.
 * @returns the new content.
 * @throws when nothing matches, or the match is ambiguous without `replaceAll`.
 */
export function replaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString) throw new Error('oldString and newString must be different')
  for (const replacer of REPLACERS) {
    for (const candidate of replacer(content, oldString)) {
      const count = occurrences(content, candidate)
      if (count === 0) continue
      if (replaceAll) return content.split(candidate).join(newString)
      if (count > 1) {
        throw new Error(
          `oldString matches ${count} locations; provide more surrounding context or set replaceAll`,
        )
      }
      const index = content.indexOf(candidate)
      return content.slice(0, index) + newString + content.slice(index + candidate.length)
    }
  }
  throw new Error('oldString not found in file (even after whitespace-tolerant matching)')
}
