/**
 * The markdown an agent actually writes, rendered as DOM.
 *
 * Nothing here builds a string of HTML. Model output is untrusted text, and
 * the one way to be sure it cannot become markup is never to parse it as
 * markup: every node is created and every character set through textContent.
 * The page's policy already forbids outside scripts, but this holds even if
 * that policy is loosened later.
 *
 * The grammar is deliberately small — fences, headings, rules, quotes, lists,
 * and inline code, emphasis, and links. Anything unrecognized stays the text
 * it was, which is the right failure for a transcript: never lose a character.
 *
 * It is called on every delta while a reply streams, so it also has to read a
 * half-written document sensibly: an unclosed fence is a code block, and an
 * unfinished emphasis is just text until its closer arrives.
 */

/*
 * A classic script rather than a module: ES imports are blocked over file://,
 * which is how Electron loads these pages. Classic scripts also share one
 * global scope, so everything below stays inside this closure and only the
 * entry point is published.
 */
;(() => {
  /** `[text](url)`, `**strong**`, `__strong__`, `*em*`, `_em_`. */
  const INLINE = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/

  /**
   * Emphasis and links, one pass, recursing into what a match contains.
   * @param text - a run of text with no code spans in it.
   * @param into - the element to append to.
   */
  function marks(text, into) {
    let rest = text
    while (rest.length > 0) {
      const found = INLINE.exec(rest)
      if (found === null) break
      if (found.index > 0) into.appendChild(document.createTextNode(rest.slice(0, found.index)))
      const [whole, linkText, href, strongStar, strongBar, emStar, emBar] = found
      if (linkText !== undefined) {
        // Not an anchor: a click would navigate the app window, and where it
        // went would be the model's choice. The address is shown instead.
        const link = document.createElement('span')
        link.className = 'md-link'
        link.title = href
        marks(linkText, link)
        into.appendChild(link)
      } else if (strongStar ?? strongBar) {
        const strong = document.createElement('strong')
        marks(strongStar ?? strongBar, strong)
        into.appendChild(strong)
      } else {
        const em = document.createElement('em')
        marks(emStar ?? emBar, em)
        into.appendChild(em)
      }
      rest = rest.slice(found.index + whole.length)
    }
    if (rest.length > 0) into.appendChild(document.createTextNode(rest))
  }

  /**
   * One line's inline content: code spans first, so nothing inside them is
   * treated as a mark.
   * @param text - the line's text.
   * @param into - the element to append to.
   */
  function inline(text, into) {
    for (const part of text.split(/(`[^`\n]*`)/g)) {
      if (part.length === 0) continue
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
        const code = document.createElement('code')
        code.textContent = part.slice(1, -1)
        into.appendChild(code)
        continue
      }
      marks(part, into)
    }
  }

  function codeBlock(lines, language) {
    const pre = document.createElement('pre')
    pre.className = 'md-code'
    if (language.length > 0) pre.dataset.language = language
    const code = document.createElement('code')
    code.textContent = lines.join('\n')
    pre.appendChild(code)
    return pre
  }

  /** A run of list items, ordered or not, each item's text parsed inline. */
  function list(items, ordered) {
    const element = document.createElement(ordered ? 'ol' : 'ul')
    element.className = 'md-list'
    for (const item of items) {
      const li = document.createElement('li')
      inline(item, li)
      element.appendChild(li)
    }
    return element
  }

  const HEADING = /^(#{1,6})\s+(.*)$/
  const BULLET = /^\s*[-*+]\s+(.*)$/
  const NUMBER = /^\s*\d+[.)]\s+(.*)$/
  const QUOTE = /^>\s?(.*)$/
  const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/
  const FENCE = /^```(.*)$/

  /**
   * Render markdown into a container, replacing whatever it held.
   * @param text - the markdown source.
   * @param into - the element to fill.
   */
  function renderMarkdown(text, into) {
    into.textContent = ''
    const lines = text.split('\n')
    let index = 0

    const paragraph = []
    const flushParagraph = () => {
      if (paragraph.length === 0) return
      const p = document.createElement('p')
      p.className = 'md-p'
      // A single newline inside a paragraph is a line break in agent output far
      // more often than it is a join.
      paragraph.forEach((line, position) => {
        if (position > 0) p.appendChild(document.createElement('br'))
        inline(line, p)
      })
      into.appendChild(p)
      paragraph.length = 0
    }

    while (index < lines.length) {
      const line = lines[index]

      const fence = FENCE.exec(line)
      if (fence !== null) {
        flushParagraph()
        const body = []
        index += 1
        // An unterminated fence is still a code block: the reply is mid-stream.
        while (index < lines.length && !FENCE.test(lines[index])) {
          body.push(lines[index])
          index += 1
        }
        into.appendChild(codeBlock(body, fence[1].trim()))
        index += 1
        continue
      }

      if (line.trim().length === 0) {
        flushParagraph()
        index += 1
        continue
      }

      if (RULE.test(line)) {
        flushParagraph()
        const rule = document.createElement('div')
        rule.className = 'md-rule'
        into.appendChild(rule)
        index += 1
        continue
      }

      const heading = HEADING.exec(line)
      if (heading !== null) {
        flushParagraph()
        const element = document.createElement(`h${Math.min(heading[1].length, 6)}`)
        element.className = 'md-h'
        inline(heading[2], element)
        into.appendChild(element)
        index += 1
        continue
      }

      if (QUOTE.test(line)) {
        flushParagraph()
        const quoted = []
        while (index < lines.length && QUOTE.test(lines[index])) {
          quoted.push(QUOTE.exec(lines[index])[1])
          index += 1
        }
        const quote = document.createElement('blockquote')
        quote.className = 'md-quote'
        renderMarkdown(quoted.join('\n'), quote)
        into.appendChild(quote)
        continue
      }

      const ordered = NUMBER.test(line)
      if (ordered || BULLET.test(line)) {
        flushParagraph()
        const items = []
        const pattern = ordered ? NUMBER : BULLET
        while (index < lines.length && pattern.test(lines[index])) {
          items.push(pattern.exec(lines[index])[1])
          index += 1
        }
        into.appendChild(list(items, ordered))
        continue
      }

      paragraph.push(line)
      index += 1
    }
    flushParagraph()
  }

  globalThis.dshMarkdown = { renderMarkdown }
})()
