/**
 * Settings window: a form generated from the harness's own schemas.
 *
 * Nothing here knows what a setting is called. The bridge sends each namespace
 * with its schemastery graph, its current value, and the revision it was read
 * at; this file walks the graph, renders a control per field, and sends back a
 * patch carrying that revision so a section edited elsewhere rejects instead
 * of being overwritten.
 */

const sheet = document.getElementById('sheet')
const bridge = globalThis.dsh ?? { send() {}, onMessage() {} }

/** Status lines survive a repaint so a save result is still readable after it. */
const statuses = new Map()

/**
 * Resolve one schemastery ref into its node.
 * @param schema - the serialized {uid, refs} graph.
 * @param id - the ref id to resolve.
 * @returns the node, or undefined when the graph omits it.
 */
function node(schema, id) {
  return schema?.refs?.[String(id)]
}

/** The fields of a namespace, in declaration order. */
function fields(schema) {
  const root = node(schema, schema?.uid)
  if (root?.dict === undefined) return []
  return Object.entries(root.dict).map(([key, id]) => ({ key, node: node(schema, id) ?? {} }))
}

function control(field, current) {
  const type = field.node.type
  if (type === 'boolean') {
    const input = document.createElement('input')
    input.className = 'field__input'
    input.type = 'checkbox'
    input.checked = current === true
    input.read = () => input.checked
    return input
  }
  if (type === 'number') {
    const input = document.createElement('input')
    input.className = 'field__input'
    input.type = 'number'
    input.value = current ?? ''
    input.read = () => (input.value.trim() === '' ? undefined : Number(input.value))
    return input
  }
  if (type === 'string') {
    const input = document.createElement('input')
    input.className = 'field__input'
    input.type = 'text'
    input.value = current ?? ''
    input.read = () => (input.value.trim() === '' ? undefined : input.value)
    return input
  }
  // Anything structured is edited as JSON rather than guessed at.
  const area = document.createElement('textarea')
  area.className = 'field__input'
  area.value = current === undefined ? '' : JSON.stringify(current, null, 2)
  area.read = () => {
    if (area.value.trim() === '') return undefined
    return JSON.parse(area.value)
  }
  return area
}

function renderSection(section) {
  const value = section.value ?? {}
  const element = document.createElement('section')
  element.className = 'section'

  const head = document.createElement('header')
  head.className = 'section__head'
  const ns = document.createElement('span')
  ns.className = 'section__ns'
  ns.textContent = section.ns
  const applies = document.createElement('span')
  applies.className = section.applies === 'restart' ? 'section__applies is-restart' : 'section__applies'
  applies.textContent = section.applies === 'restart' ? 'takes effect on restart' : 'takes effect live'
  head.append(ns, applies)
  element.appendChild(head)

  const controls = []
  const list = fields(section.schema)
  for (const field of list) {
    const row = document.createElement('div')
    row.className = 'field'
    const label = document.createElement('label')
    label.className = field.node.meta?.required === true ? 'field__label is-required' : 'field__label'
    label.textContent = field.key
    const input = control(field, value[field.key])
    label.htmlFor = `${section.ns}-${field.key}`
    input.id = label.htmlFor
    row.append(label, input)
    element.appendChild(row)
    if (typeof field.node.meta?.description === 'string') {
      const note = document.createElement('p')
      note.className = 'field__note'
      note.textContent = field.node.meta.description
      element.appendChild(note)
    }
    controls.push({ key: field.key, input })
  }

  const foot = document.createElement('div')
  foot.className = 'section__foot'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'section__save'
  save.textContent = 'Save'
  const status = document.createElement('span')
  status.className = 'section__status'
  status.textContent = statuses.get(section.ns)?.text ?? ''
  if (statuses.get(section.ns)?.kind) status.classList.add(statuses.get(section.ns).kind)

  save.addEventListener('click', () => {
    const patch = {}
    try {
      for (const { key, input } of controls) {
        const read = input.read()
        if (read !== undefined) patch[key] = read
      }
    } catch (error) {
      statuses.set(section.ns, { text: `Not valid JSON: ${error.message}`, kind: 'is-fault' })
      status.textContent = statuses.get(section.ns).text
      status.className = 'section__status is-fault'
      return
    }
    statuses.set(section.ns, { text: 'Saving…' })
    status.textContent = 'Saving…'
    status.className = 'section__status'
    bridge.send({ type: 'settings_update', ns: section.ns, patch, revision: section.revision })
  })

  if (list.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'sheet__empty'
    empty.textContent = 'This section has no editable fields.'
    element.appendChild(empty)
  }

  foot.append(save, status)
  element.appendChild(foot)
  return element
}

function render(sections) {
  sheet.textContent = ''
  if (sections.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'sheet__empty'
    empty.textContent = 'No row in this profile registers settings yet. Rows that do will appear here on their own.'
    sheet.appendChild(empty)
    return
  }
  for (const section of sections) sheet.appendChild(renderSection(section))
}

/**
 * The single entry point, as in the main window: the preload feeds it, and a
 * preview page can feed it the same shapes.
 * @param message - one bridge message.
 */
function apply(message) {
  if (message.type === 'settings') {
    // A save answers with the fresh picture, so a pending "Saving…" resolves.
    for (const [ns, entry] of statuses) {
      if (entry.text === 'Saving…') statuses.set(ns, { text: 'Saved', kind: 'is-saved' })
    }
    render(message.sections)
    return
  }
  if (message.type === 'settings_rejected') {
    statuses.set(message.ns, { text: message.message, kind: 'is-fault' })
    return
  }
  if (message.type === 'welcome') bridge.send({ type: 'settings_describe' })
}

globalThis.dshSettings = { apply }
bridge.onMessage(apply)
bridge.send({ type: 'settings_describe' })
