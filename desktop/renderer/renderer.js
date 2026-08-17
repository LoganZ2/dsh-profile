/**
 * Renderer: fold bridge messages into the wire.
 *
 * Every entry hangs off one continuous trace in the left gutter. The trace
 * pulses while the model streams and opens (dashes, hollow node) while a gate
 * waits on a decision, so the socket's state is always visible as structure.
 *
 * `window.dshRenderer.apply(message)` is the single entry point: the Electron
 * preload feeds it, and a preview page can feed it the same shapes.
 */

const { renderMarkdown } = globalThis.dshMarkdown

const transcript = document.getElementById('transcript')
const blank = document.getElementById('blank')
const composer = document.getElementById('composer')
const input = document.getElementById('input')
const sendButton = document.getElementById('send')
const rack = document.getElementById('rack')
const rackToggle = document.getElementById('rack-toggle')
const settingsButton = document.getElementById('settings')
const modelSelect = document.getElementById('model')
const modeButton = document.getElementById('mode')
const workspaceButton = document.getElementById('workspace')
const workspaceName = document.getElementById('workspace-name')
const sessionList = document.getElementById('session-list')
const confirmDialog = document.getElementById('confirm')
const confirmQuestion = document.getElementById('confirm-question')
const newSession = document.getElementById('new-session')

let sessionId
let working = false
/** Suppresses entry animation while a resumed log paints in one burst. */
let replaying = false
/** Streaming text/reasoning by chunk index, for the open assistant entry. */
let blocks = new Map()
let assistant
/** Tool entries awaiting their result, by tool call id. */
const toolCalls = new Map()
const pendingGates = new Set()

const bridge = globalThis.dsh ?? { send() {}, onMessage() {}, openSettings() {} }

/* ---- shell ---------------------------------------------------------- */

function atBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60
}

function append(node) {
  const pinned = atBottom()
  blank.hidden = true
  transcript.appendChild(node)
  if (pinned) transcript.scrollTop = transcript.scrollHeight
}

function stamp(time) {
  const at = typeof time === 'number' ? new Date(time) : new Date()
  return at.toTimeString().slice(0, 8)
}

/**
 * Build an entry hung off the wire.
 * @param kind - origin class suffix: you, model, tool, gate, fault.
 * @param origin - the silkscreen label.
 * @param time - event timestamp in ms, when the event carried one.
 * @returns the entry element and its body container.
 */
function entry(kind, origin, time) {
  const element = document.createElement('article')
  element.className = replaying ? `entry entry--${kind}` : `entry entry--${kind} animate-in`
  const rail = document.createElement('div')
  rail.className = 'rail'
  const node = document.createElement('span')
  node.className = 'node'
  rail.appendChild(node)
  const head = document.createElement('header')
  head.className = 'head'
  const label = document.createElement('span')
  label.className = 'origin'
  label.textContent = origin
  const clock = document.createElement('span')
  clock.className = 'stamp'
  clock.textContent = stamp(time)
  head.append(label, clock)
  const body = document.createElement('div')
  element.append(rail, head, body)
  return { element, body }
}

/** Connection as the host reports it: starting, connected, or stopped. */
let connection = 'starting'

function setPhase() {
  const state = connection === 'stopped'
    ? 'offline'
    : connection === 'starting'
      ? 'starting'
      : pendingGates.size > 0 ? 'gated' : working ? 'working' : 'ready'
  // While a turn runs the primary action is to end it, so the one button
  // becomes Stop rather than sitting there disabled.
  const stoppable = state === 'working' || state === 'gated'
  sendButton.textContent = stoppable ? 'Stop' : 'Send'
  sendButton.classList.toggle('is-stop', stoppable)
  sendButton.disabled = !stoppable && state !== 'ready'
}

function addFault(text) {
  closeAssistant()
  const built = entry('fault', 'Fault', Date.now())
  const body = document.createElement('div')
  body.className = 'text'
  body.textContent = text
  built.body.appendChild(body)
  append(built.element)
}

/** A quiet line on the wire for something that happened but did not speak. */
function addNote(text) {
  closeAssistant()
  const built = entry('note', text, Date.now())
  append(built.element)
}

function addUserPrompt(text, time) {
  const built = entry('you', 'You', time)
  const body = document.createElement('div')
  body.className = 'text'
  body.textContent = text
  built.body.appendChild(body)
  append(built.element)
}

/* ---- assistant output ----------------------------------------------- */

function openAssistant(time) {
  if (assistant !== undefined) return assistant
  const built = entry('model', 'Model', time)
  built.element.classList.add('is-live')
  const reason = document.createElement('div')
  reason.className = 'reason'
  reason.hidden = true
  const text = document.createElement('div')
  text.className = 'text'
  const waiting = document.createElement('div')
  waiting.className = 'waiting'
  waiting.textContent = 'Working'
  built.body.append(waiting, reason, text)
  append(built.element)
  assistant = { ...built, reason, text, waiting }
  return assistant
}

function paint() {
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
  const pinned = atBottom()
  assistant.reason.textContent = ordered.filter(b => b.kind === 'reasoning').map(b => b.text).join('\n').trim()
  assistant.reason.hidden = assistant.reason.textContent.length === 0
  renderMarkdown(ordered.filter(b => b.kind === 'text').map(b => b.text).join(''), assistant.text)
  // The placeholder stands only until the model actually says something.
  assistant.waiting.hidden = assistant.text.childNodes.length > 0 || !assistant.reason.hidden
  if (pinned) transcript.scrollTop = transcript.scrollHeight
}

function accumulate(index, kind, text, time) {
  openAssistant(time)
  const block = blocks.get(index) ?? { kind, text: '' }
  block.text += text
  blocks.set(index, block)
  paint()
}

function closeAssistant() {
  assistant?.element.classList.remove('is-live')
  if (assistant !== undefined && assistant.text.childNodes.length === 0 && assistant.reason.hidden) {
    assistant.element.remove()
  }
  assistant = undefined
  blocks = new Map()
}

/* ---- tool calls ------------------------------------------------------ */

/** The one fact worth showing for a call: the command, the path, or the args. */
function callSummary(name, rawArguments) {
  let args
  try {
    args = JSON.parse(rawArguments || '{}')
  } catch {
    return rawArguments
  }
  const single = args.command ?? args.filePath ?? args.filepath ?? args.path ?? args.pattern
  if (typeof single === 'string') return single
  return Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')
}

function addToolCall(block, time) {
  closeAssistant()
  const built = entry('tool', block.name ?? 'Tool', time)
  const cmd = document.createElement('div')
  cmd.className = 'cmd'
  cmd.textContent = callSummary(block.name, block.arguments)
  built.body.appendChild(cmd)
  append(built.element)
  if (typeof block.callId === 'string') toolCalls.set(block.callId, built)
}

function addToolResult(data) {
  const message = data?.message
  const result = message?.content?.find(part => part.type === 'tool-result')
  const target = toolCalls.get(result?.toolCallId)
  const failed = result?.isError === true || data?.error !== undefined
  const text = (result?.content ?? [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
  const shown = text.length > 0 ? text : data?.error?.name ?? 'no output'
  const out = document.createElement('pre')
  out.className = failed ? 'out is-fault' : 'out'
  out.textContent = shown
  out.title = 'Click to expand'
  out.addEventListener('click', () => out.classList.toggle('is-open'))
  if (target === undefined) {
    const built = entry(failed ? 'fault' : 'tool', 'Result', data?.time)
    built.body.appendChild(out)
    append(built.element)
    return
  }
  target.body.appendChild(out)
  if (failed) target.element.classList.add('entry--fault')
  toolCalls.delete(result.toolCallId)
}

/* ---- gates ----------------------------------------------------------- */

function renderDiff(diff) {
  const pre = document.createElement('pre')
  pre.className = 'gate__diff'
  for (const line of diff.split('\n')) {
    const row = document.createElement('span')
    row.className = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : line.startsWith('@@') ? 'diff-meta' : ''
    row.textContent = `${line}\n`
    pre.appendChild(row)
  }
  return pre
}

function addGate(id, request) {
  closeAssistant()
  const built = entry('gate', `Gate · ${request.permission}`, Date.now())
  built.element.classList.add('is-pending')
  pendingGates.add(id)

  const card = document.createElement('div')
  card.className = 'gate'
  const what = document.createElement('div')
  what.className = 'gate__what'
  what.textContent = request.metadata?.command ?? request.patterns.join('\n')
  card.appendChild(what)
  if (typeof request.metadata?.diff === 'string') card.appendChild(renderDiff(request.metadata.diff))

  const choices = document.createElement('div')
  choices.className = 'gate__choices'
  const options = [
    { reply: 'once', label: 'Allow once', className: 'choice choice--primary', verdict: 'Allowed once' },
    { reply: 'always', label: 'Always allow', className: 'choice', verdict: 'Allowed from now on' },
    { reply: 'reject', label: 'Deny', className: 'choice choice--deny', verdict: 'Denied' },
  ]
  for (const option of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = option.className
    button.textContent = option.label
    button.addEventListener('click', () => {
      bridge.send({ type: 'permission_reply', id, reply: option.reply })
      pendingGates.delete(id)
      built.element.classList.remove('is-pending')
      choices.remove()
      note?.remove()
      const verdict = document.createElement('div')
      verdict.className = 'gate__verdict'
      verdict.textContent = option.verdict
      card.appendChild(verdict)
      setPhase()
    })
    choices.appendChild(button)
  }
  card.appendChild(choices)

  let note
  if (Array.isArray(request.always) && request.always.length > 0) {
    note = document.createElement('div')
    note.className = 'gate__note'
    note.textContent = `Always allow adds the rule ${request.permission} ${request.always.join(', ')}`
    card.appendChild(note)
  }

  built.body.appendChild(card)
  append(built.element)
  setPhase()
}

/* ---- the picker ------------------------------------------------------ */

/** Today shows the clock; anything older shows the date. */
function whenLabel(ms) {
  const at = new Date(ms)
  const today = new Date()
  const sameDay = at.toDateString() === today.toDateString()
  return sameDay ? at.toTimeString().slice(0, 5) : `${at.getMonth() + 1}/${at.getDate()}`
}

/** The last list the server sent, repainted whenever the current session moves. */
let sessionRows = []

function renderSessions(sessions) {
  sessionRows = sessions
  sessionList.textContent = ''
  if (sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'rack__empty'
    empty.textContent = 'No stored conversations yet.'
    sessionList.appendChild(empty)
    return
  }
  for (const session of sessions) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'tab'
    if (session.id === sessionId) tab.classList.add('is-current')
    if (session.title === undefined) tab.classList.add('is-untitled')
    const title = document.createElement('span')
    title.className = 'tab__title'
    title.textContent = session.title ?? 'Untitled'
    const meta = document.createElement('span')
    meta.className = 'tab__meta'
    meta.textContent = whenLabel(session.createdAt)
    // Deleting is destructive and unattended, so it asks once, in place.
    const close = document.createElement('span')
    close.className = 'tab__close'
    close.textContent = '\u00d7'
    close.title = 'Delete this conversation'
    close.setAttribute('role', 'button')
    close.addEventListener('click', async (event) => {
      event.stopPropagation()
      const label = session.title ?? 'this untitled conversation'
      if (!await confirmAsk(`Delete “${label}”?`)) return
      bridge.send({ type: 'session_delete', sessionId: session.id })
      if (session.id === sessionId) {
        sessionId = undefined
        resetTranscript()
      }
    })
    const detail = document.createElement('span')
    detail.className = 'tab__detail'
    detail.textContent = session.cwd ?? ''
    tab.title = `${session.title ?? 'Untitled'}\nStarted ${new Date(session.createdAt).toLocaleString()}\n${session.cwd ?? ''}`
    tab.append(title, meta, close, detail)
    tab.addEventListener('click', () => {
      if (session.id === sessionId || working) return
      if (session.cwd !== undefined) showWorkspace(session.cwd)
      collapseRack()
      resetTranscript()
      working = true
      setPhase()
      bridge.send({ type: 'resume', sessionId: session.id })
    })
    sessionList.appendChild(tab)
  }
}

function resetTranscript() {
  for (const old of transcript.querySelectorAll('.entry')) old.remove()
  blank.hidden = false
  closeAssistant()
  toolCalls.clear()
  pendingGates.clear()
}

/** Paint a resumed conversation from its stored log. */
function replay(events) {
  replaying = true
  for (const event of events) {
    if (event.type === 'user/message') addUserPrompt(event.data.content?.[0]?.text ?? '', event.time)
    else onEvent(event)
  }
  closeAssistant()
  replaying = false
  transcript.scrollTop = transcript.scrollHeight
}

/* ---- session events -------------------------------------------------- */

function onChunk(chunk, time) {
  if (chunk.type === 'text-delta') accumulate(chunk.index, 'text', chunk.text, time)
  else if (chunk.type === 'reasoning-delta') accumulate(chunk.index, 'reasoning', chunk.text, time)
  else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
    openAssistant(time)
    blocks.set(chunk.index, { kind: 'text', text: chunk.block.text })
    paint()
  } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') addToolCall(chunk.block, time)
}

function onEvent(event) {
  switch (event.type) {
    case 'turn/start':
      working = true
      setPhase()
      return
    case 'turn/end': {
      // A failed turn used to end in silence: the loop records the reason here
      // and nowhere else the client sees.
      const reason = event.data?.reason
      if (reason?.kind === 'error') addFault(reason.error?.message ?? 'The turn failed.')
      // A turn you ended yourself is not a fault; it still has to be visible,
      // or the transcript just stops mid-sentence with no reason given.
      else if (reason?.kind === 'aborted') addNote('Stopped')
      return
    }
    case 'assistant/chunk':
      onChunk(event.data.chunk, event.time)
      return
    case 'assistant/message':
      closeAssistant()
      return
    case 'tool/result':
      addToolResult({ ...event.data, time: event.time })
      return
    default:
  }
}

/* ---- host messages --------------------------------------------------- */

function apply(message) {
  switch (message.type) {
    case 'status':
      connection = message.state
      if (connection !== 'connected') working = false
      // Nothing stands watch in the chrome any more, so a dead harness has to
      // announce itself on the wire.
      if (connection === 'stopped') addFault('The harness stopped. Restart the app to reconnect.')
      setPhase()
      return
    case 'welcome':
      connection = 'connected'
      setPhase()
      bridge.send({ type: 'sessions' })
      bridge.send({ type: 'models' })
      return
    case 'models':
      renderModels(message.models ?? [], message.current)
      return
    case 'mode':
      // The harness is the authority on what actually took effect.
      showMode(message.mode, message.applied)
      return
    case 'session': {
      sessionId = message.sessionId
      const row = sessionRows.find(entry => entry.id === sessionId)
      if (row?.cwd !== undefined) showWorkspace(row.cwd)
      renderSessions(sessionRows)
      return
    }
    case 'sessions':
      renderSessions(message.sessions)
      return
    case 'history':
      replay(message.events)
      return
    case 'event':
      onEvent(message.event)
      return
    case 'permission_ask':
      addGate(message.id, message.request)
      return
    case 'idle':
      closeAssistant()
      working = false
      setPhase()
      // A settled turn may have minted a session or earned it a title.
      bridge.send({ type: 'sessions' })
      return
    case 'error':
      addFault(message.message)
      working = false
      setPhase()
      return
    default:
  }
}

/* ---- composer -------------------------------------------------------- */

function submit() {
  // Mid-turn the button stops the agent instead of sending.
  if (sendButton.classList.contains('is-stop')) {
    bridge.send({ type: 'stop', ...(sessionId === undefined ? {} : { sessionId }) })
    return
  }
  const text = input.value.trim()
  if (text.length === 0 || sendButton.disabled) return
  input.value = ''
  input.style.height = 'auto'
  addUserPrompt(text, Date.now())
  working = true
  setPhase()
  openAssistant()
  bridge.send({
    type: 'prompt',
    text,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionId === undefined && workspace !== undefined ? { cwd: workspace } : {}),
  })
}

/**
 * Ask before something irreversible. A native dialog traps focus and handles
 * Escape, so the only thing left to own is the answer.
 * @param question - what is about to happen, naming the subject.
 * @returns whether to go ahead.
 */
function confirmAsk(question) {
  confirmQuestion.textContent = question
  confirmDialog.showModal()
  return new Promise((resolve) => {
    const finish = (answer) => {
      confirmDialog.close()
      document.getElementById('confirm-delete').removeEventListener('click', onYes)
      document.getElementById('confirm-cancel').removeEventListener('click', onNo)
      confirmDialog.removeEventListener('cancel', onNo)
      resolve(answer)
    }
    const onYes = () => finish(true)
    const onNo = () => finish(false)
    document.getElementById('confirm-delete').addEventListener('click', onYes)
    document.getElementById('confirm-cancel').addEventListener('click', onNo)
    confirmDialog.addEventListener('cancel', onNo)
  })
}

/* ---- mode ------------------------------------------------------------- */

/** 'plan' researches and is denied edits; 'build' acts. */
let mode = 'build'

function showMode(next, applied) {
  mode = next
  modeButton.dataset.mode = next
  for (const side of modeButton.querySelectorAll('.switch__side')) {
    const on = side.dataset.side === next
    side.setAttribute('aria-pressed', String(on))
    side.title = side.dataset.side === 'plan'
      ? 'Reads and searches; edits are refused'
      : 'Edits and commands, subject to the usual gates'
  }
  // A switch inside a running turn only lands at the next step boundary.
  if (applied === 'queued') addNote('Plan mode takes effect at the next step')
}

modeButton.addEventListener('click', (event) => {
  const side = event.target.closest('.switch__side')
  if (side === null || side.dataset.side === mode) return
  showMode(side.dataset.side)
  bridge.send({ type: 'mode', mode: side.dataset.side, ...(sessionId === undefined ? {} : { sessionId }) })
})

/* ---- workspace -------------------------------------------------------- */

/** The folder the next conversation opens in. A session's own cwd is fixed. */
let workspace

function showWorkspace(path) {
  workspace = path
  workspaceName.textContent = path === undefined ? 'no folder' : path.split('/').filter(Boolean).pop() ?? path
  workspaceButton.title = path === undefined
    ? 'Choose the folder this conversation works in'
    : `${path}\nA conversation keeps the folder it opened in; choosing another starts a new one.`
}

workspaceButton.addEventListener('click', async () => {
  const picked = await bridge.pickWorkspace?.()
  if (picked === undefined || picked === workspace) return
  showWorkspace(picked)
  // A session's workspace is fixed at creation, so a new folder means a new
  // conversation rather than a silent mismatch with the one on screen.
  if (sessionId !== undefined) {
    sessionId = undefined
    resetTranscript()
  }
  input.focus()
})

/* ---- model selection -------------------------------------------------- */

/** The catalog as the harness reports it, and what is chosen. */
let modelCurrent = { provider: undefined, model: undefined }

function renderModels(models, current) {
  modelCurrent = current ?? modelCurrent
  modelSelect.textContent = ''
  if (models.length === 0) {
    const option = document.createElement('option')
    option.textContent = 'no models'
    modelSelect.appendChild(option)
    modelSelect.disabled = true
    return
  }
  modelSelect.disabled = false
  // A selection can outlive the route that served it — a renamed or deleted
  // one. Show it rather than letting the box display someone else's model.
  const known = models.some(e => e.provider === modelCurrent.provider && e.id === modelCurrent.model)
  if (!known && modelCurrent.provider !== undefined && modelCurrent.model !== undefined) {
    const stale = document.createElement('option')
    stale.value = `${modelCurrent.provider}\u0000${modelCurrent.model}`
    stale.textContent = `${modelCurrent.model}  ·  ${modelCurrent.provider} (not configured)`
    modelSelect.appendChild(stale)
  }
  for (const entry of models) {
    const option = document.createElement('option')
    option.value = `${entry.provider}\u0000${entry.id}`
    // The route matters as much as the model: two routes can serve one id.
    option.textContent = `${entry.id}  ·  ${entry.provider}`
    modelSelect.appendChild(option)
  }
  const chosen = `${modelCurrent.provider}\u0000${modelCurrent.model}`
  if ([...modelSelect.options].some(o => o.value === chosen)) modelSelect.value = chosen
}

modelSelect.addEventListener('change', () => {
  const [provider, model] = modelSelect.value.split('\u0000')
  if (provider === undefined || model === undefined) return
  bridge.send({ type: 'model_select', provider, model, ...(sessionId === undefined ? {} : { sessionId }) })
})

/* ---- rack ------------------------------------------------------------ */

function collapseRack() {
  rack.classList.remove('is-expanded')
  rackToggle.setAttribute('aria-expanded', 'false')
  rackToggle.title = 'Show every conversation'
}

settingsButton.addEventListener('click', () => {
  bridge.openSettings?.()
})

rackToggle.addEventListener('click', () => {
  const expanded = rack.classList.toggle('is-expanded')
  rackToggle.setAttribute('aria-expanded', String(expanded))
  rackToggle.title = expanded ? 'Show the tab strip' : 'Show every conversation'
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (confirmDialog.open) return
  if (rack.classList.contains('is-expanded')) {
    collapseRack()
    return
  }
  if (working) bridge.send({ type: 'stop', ...(sessionId === undefined ? {} : { sessionId }) })
})

newSession.addEventListener('click', () => {
  if (working) return
  collapseRack()
  sessionId = undefined
  resetTranscript()
  bridge.send({ type: 'sessions' })
  input.focus()
})

composer.addEventListener('submit', (event) => {
  event.preventDefault()
  submit()
})

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
})

showWorkspace(undefined)
globalThis.dshRenderer = { apply }
bridge.onMessage(apply)
setPhase()
input.focus()
