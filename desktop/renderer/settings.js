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

/** Route ids the harness holds a credential for. Whether, never what. */
let storedKeys = new Set()

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

/** The literal choices of a union-of-consts, or undefined when it is not one. */
function choices(schema, ref) {
  const list = ref?.list
  if (!Array.isArray(list)) return undefined
  const values = list.map(id => node(schema, id)).filter(n => n?.type === 'const').map(n => n.value)
  return values.length === list.length && values.length > 0 ? values : undefined
}

/**
 * One editable control for a leaf field.
 * @param schema - the graph the node belongs to.
 * @param ref - the field's schema node.
 * @param current - its current value.
 * @returns an element carrying a `read()` that returns the edited value.
 */
function control(schema, ref, current) {
  const options = choices(schema, ref)
  if (options !== undefined) {
    const select = document.createElement('select')
    select.className = 'field__input'
    for (const value of ['', ...options]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value === '' ? '—' : value
      select.appendChild(option)
    }
    select.value = current ?? ''
    select.read = () => (select.value === '' ? undefined : select.value)
    return select
  }
  if (ref?.type === 'boolean') {
    const input = document.createElement('input')
    input.className = 'field__input'
    input.type = 'checkbox'
    input.checked = current === true
    input.read = () => input.checked
    return input
  }
  if (ref?.type === 'number') {
    const input = document.createElement('input')
    input.className = 'field__input'
    input.type = 'number'
    input.value = current ?? ''
    input.read = () => (input.value.trim() === '' ? undefined : Number(input.value))
    return input
  }
  if (ref?.type === 'string') {
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
  area.read = () => (area.value.trim() === '' ? undefined : JSON.parse(area.value))
  return area
}

/**
 * The sheet's one action affordance at this scale.
 * @param label - the button's text.
 * @param onClick - what it does.
 * @returns the button.
 */
function mini(label, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'mini'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

/**
 * Render one field into a container, dispatching on its schema node: a
 * dictionary and an array own their layout, everything else is a labelled row.
 * @param schema - the graph.
 * @param key - the field name.
 * @param ref - the field's schema node.
 * @param value - its current value.
 * @param into - the element to append to.
 * @returns the field's key and a `read()` for its edited value.
 */
function renderField(schema, key, ref, value, into, secrets = false, base = undefined) {
  if (ref.type === 'dict' || ref.type === 'array') {
    const caption = document.createElement('div')
    caption.className = 'dict__caption'
    caption.textContent = key
    const widget = ref.type === 'dict' ? dictField(schema, ref, value, secrets, base) : arrayField(schema, ref, value)
    into.append(caption, widget)
    return { key, read: () => widget.read() }
  }
  const row = document.createElement('div')
  row.className = 'field'
  const label = document.createElement('label')
  label.className = ref.meta?.required === true ? 'field__label is-required' : 'field__label'
  label.textContent = key
  const input = control(schema, ref, value)
  row.append(label, input)
  into.appendChild(row)
  if (typeof ref.meta?.description === 'string') {
    const note = document.createElement('p')
    note.className = 'field__note'
    note.textContent = ref.meta.description
    into.appendChild(note)
  }
  return { key, read: () => input.read() }
}

/**
 * Lay one object's fields into a container.
 * @param schema - the graph.
 * @param objectRef - an object node with a `dict` of fields.
 * @param value - the object's current value.
 * @param into - the element to append rows to.
 * @returns a `read()` returning the edited object.
 */
function objectFields(schema, objectRef, value, into) {
  const readers = []
  for (const [key, id] of Object.entries(objectRef?.dict ?? {})) {
    readers.push(renderField(schema, key, node(schema, id) ?? {}, (value ?? {})[key], into))
  }
  return () => {
    const out = {}
    for (const reader of readers) {
      const read = reader.read()
      if (read !== undefined) out[reader.key] = read
    }
    return out
  }
}

/**
 * A route's API key. It is written straight to the harness's credential file
 * and never sent back, so this shows only whether one is on file and offers to
 * replace or forget it.
 * @param routeId - the route the key belongs to.
 * @returns the row.
 */
function keyRow(routeId) {
  const row = document.createElement('div')
  row.className = 'field'
  const label = document.createElement('label')
  label.className = 'field__label'
  label.textContent = 'apiKey'
  const box = document.createElement('div')
  box.className = 'key'
  const input = document.createElement('input')
  input.className = 'field__input'
  input.type = 'password'
  input.autocomplete = 'off'
  input.placeholder = storedKeys.has(routeId) ? 'stored — type to replace' : 'paste the key'
  const save = mini('Set', () => {
    if (input.value.length === 0) return
    bridge.send({ type: 'provider_key_set', route: routeId, key: input.value })
    input.value = ''
  })
  const forget = mini('Forget', () => {
    bridge.send({ type: 'provider_key_set', route: routeId })
  })
  box.append(input, save, forget)
  row.append(label, box)
  return row
}

/** What to call one item of a list: its own identity if it has one. */
function itemLabel(item, index) {
  const named = item !== null && typeof item === 'object' ? item.id ?? item.name : undefined
  return typeof named === 'string' && named.length > 0 ? named : `#${index + 1}`
}

/**
 * An array field as a list of items rather than a blob of JSON. Items shaped
 * by an object schema become cards of fields; anything else becomes one row of
 * control plus Remove.
 * @param schema - the graph.
 * @param arrayRef - the array node.
 * @param value - the current items.
 * @returns an element carrying a `read()` returning the edited array.
 */
function arrayField(schema, arrayRef, value) {
  const wrapper = document.createElement('div')
  wrapper.className = 'list'
  const inner = node(schema, arrayRef.inner) ?? {}
  let items = Array.isArray(value) ? [...value] : []
  let readers = []

  const collect = () => readers.map(read => read())

  const paint = () => {
    wrapper.textContent = ''
    readers = []
    items.forEach((item, index) => {
      if (inner.type === 'object') {
        const card = document.createElement('div')
        card.className = 'item'
        const head = document.createElement('div')
        head.className = 'item__head'
        const name = document.createElement('span')
        name.className = 'item__name'
        name.textContent = itemLabel(item, index)
        head.append(name, mini('Remove', () => {
          items = collect()
          items.splice(index, 1)
          paint()
        }))
        card.appendChild(head)
        readers.push(objectFields(schema, inner, item, card))
        wrapper.appendChild(card)
        return
      }
      const row = document.createElement('div')
      row.className = 'list__row'
      const input = control(schema, inner, item)
      row.append(input, mini('Remove', () => {
        items = collect()
        items.splice(index, 1)
        paint()
      }))
      readers.push(() => input.read())
      wrapper.appendChild(row)
    })

    const add = document.createElement('div')
    add.className = 'list__add'
    add.appendChild(mini('Add', () => {
      items = [...collect(), inner.type === 'object' ? {} : undefined]
      paint()
    }))
    wrapper.appendChild(add)
  }

  paint()
  wrapper.read = () => collect().filter(item => item !== undefined)
  return wrapper
}

/**
 * A dictionary field — an open set of named entries, each shaped by one inner
 * schema. Provider routes are the reason this exists: the names are the user's
 * and only the shape of each entry is fixed.
 * @param schema - the graph.
 * @param dictRef - the dict node.
 * @param value - the current entries.
 * @returns an element carrying a `read()` returning the edited dictionary.
 */
function dictField(schema, dictRef, value, secrets = false, base = undefined) {
  const wrapper = document.createElement('div')
  wrapper.className = 'dict'
  const inner = node(schema, dictRef.inner) ?? {}
  const entries = new Map(Object.entries(value ?? {}))
  // Entries the profile row supplies. Settings layer OVER that row, so these
  // cannot be renamed or removed here — a write only shadows them.
  const inherited = new Set(Object.keys(base ?? {}))
  let readers = new Map()
  let names = new Map()

  const keep = () => {
    for (const [existing, read] of readers) entries.set(existing, read())
  }

  const paint = () => {
    wrapper.textContent = ''
    readers = new Map()
    names = new Map()
    for (const [key, entryValue] of entries) {
      const card = document.createElement('div')
      card.className = 'route'
      const head = document.createElement('div')
      head.className = 'route__head'
      // The id is the route's identity — the thing a model selection names —
      // so it has to be editable here, not only at the moment of adding.
      const label = document.createElement('input')
      label.className = 'field__input route__name'
      label.type = 'text'
      label.value = key
      label.spellcheck = false
      if (inherited.has(key)) {
        // Saying so beats letting a rename appear to work and then come back.
        label.readOnly = true
        label.title = 'Declared by the profile — rename or remove it in cordis.patch.yml'
        const note = document.createElement('span')
        note.className = 'route__origin'
        note.textContent = 'from profile'
        head.append(label, note)
      } else {
        label.title = 'Route id — what a model selection names'
        head.append(label, mini('Remove', () => {
          keep()
          entries.delete(key)
          paint()
        }))
      }
      card.appendChild(head)
      const read = objectFields(schema, inner, entryValue, card)
      if (secrets) card.appendChild(keyRow(key))
      readers.set(key, () => read())
      names.set(key, label)
      wrapper.appendChild(card)
    }

    const add = document.createElement('div')
    add.className = 'dict__add'
    const name = document.createElement('input')
    name.className = 'field__input'
    name.type = 'text'
    name.placeholder = 'route name'
    const submit = () => {
      const key = name.value.trim()
      if (key === '' || entries.has(key)) return
      keep()
      entries.set(key, {})
      paint()
    }
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submit() }
    })
    add.append(name, mini('Add', submit))
    wrapper.appendChild(add)
  }

  paint()
  wrapper.read = () => {
    const out = {}
    for (const [key, read] of readers) {
      const renamed = names.get(key)?.value.trim()
      out[renamed !== undefined && renamed.length > 0 ? renamed : key] = read()
    }
    return out
  }
  return wrapper
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
  for (const field of fields(section.schema)) {
    // Only the LLM layer's route table carries credentials.
    const secrets = section.ns === 'llm-pi' && field.key === 'providers'
    controls.push(renderField(section.schema, field.key, field.node, value[field.key], element, secrets, (section.base ?? {})[field.key]))
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
    // The form holds the whole section and writes it back whole: that is what
    // lets a route be renamed or removed at all.
    const next = {}
    try {
      for (const reader of controls) {
        const read = reader.read()
        if (read !== undefined) next[reader.key] = read
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
    bridge.send({ type: 'settings_update', ns: section.ns, section: next, revision: section.revision })
  })

  if (controls.length === 0) {
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
/** The last sections the harness sent, so a key change can repaint without asking again. */
let lastSections = []

function apply(message) {
  if (message.type === 'settings') {
    // A save answers with the fresh picture, so a pending "Saving…" resolves.
    for (const [ns, entry] of statuses) {
      if (entry.text === 'Saving…') statuses.set(ns, { text: 'Saved', kind: 'is-saved' })
    }
    lastSections = message.sections
    render(lastSections)
    return
  }
  if (message.type === 'provider_keys') {
    // Repaint from what we already hold. Asking the harness again from inside
    // its own answer is how this turned into a message storm.
    storedKeys = new Set(message.stored ?? [])
    render(lastSections)
    return
  }
  if (message.type === 'settings_rejected') {
    statuses.set(message.ns, { text: message.message, kind: 'is-fault' })
    return
  }
  if (message.type === 'welcome') {
    bridge.send({ type: 'provider_keys' })
    bridge.send({ type: 'settings_describe' })
  }
}

globalThis.dshSettings = { apply }
bridge.onMessage(apply)
bridge.send({ type: 'provider_keys' })
bridge.send({ type: 'settings_describe' })
