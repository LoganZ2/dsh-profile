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

const transcript = document.getElementById('transcript')
const blank = document.getElementById('blank')
const composer = document.getElementById('composer')
const input = document.getElementById('input')
const sendButton = document.getElementById('send')
const lamp = document.getElementById('lamp')
const lampText = document.getElementById('lamp-text')
const plateProfile = document.getElementById('plate-profile')
const plateModel = document.getElementById('plate-model')
const plateTools = document.getElementById('plate-tools')

let sessionId
let working = false
/** Streaming text/reasoning by chunk index, for the open assistant entry. */
let blocks = new Map()
let assistant
/** Tool entries awaiting their result, by tool call id. */
const toolCalls = new Map()
const pendingGates = new Set()

const bridge = globalThis.dsh ?? { send() {} , onMessage() {} }

/* ---- shell ---------------------------------------------------------- */

function atBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60
}

function append(node) {
  const pinned = atBottom()
  blank?.remove()
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
  element.className = `entry entry--${kind} animate-in`
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

const LAMP = {
  starting: 'Starting harness',
  ready: 'Ready',
  working: 'Working',
  gated: 'Waiting on you',
  offline: 'Harness stopped',
}

/** Connection as the host reports it: starting, connected, or stopped. */
let connection = 'starting'

function setPhase() {
  const state = connection === 'stopped'
    ? 'offline'
    : connection === 'starting'
      ? 'starting'
      : pendingGates.size > 0 ? 'gated' : working ? 'working' : 'ready'
  lamp.dataset.state = state
  lampText.textContent = LAMP[state]
  sendButton.disabled = state !== 'ready'
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
  built.body.append(reason, text)
  append(built.element)
  assistant = { ...built, reason, text }
  return assistant
}

function paint() {
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
  const pinned = atBottom()
  assistant.reason.textContent = ordered.filter(b => b.kind === 'reasoning').map(b => b.text).join('\n').trim()
  assistant.reason.hidden = assistant.reason.textContent.length === 0
  assistant.text.textContent = ordered.filter(b => b.kind === 'text').map(b => b.text).join('')
  if (pinned) transcript.scrollTop = transcript.scrollHeight
}

function accumulate(index, kind, text) {
  openAssistant()
  const block = blocks.get(index) ?? { kind, text: '' }
  block.text += text
  blocks.set(index, block)
  paint()
}

function closeAssistant() {
  assistant?.element.classList.remove('is-live')
  if (assistant !== undefined && assistant.text.textContent.length === 0 && assistant.reason.hidden) {
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

/* ---- session events -------------------------------------------------- */

function onChunk(chunk, time) {
  if (chunk.type === 'text-delta') accumulate(chunk.index, 'text', chunk.text)
  else if (chunk.type === 'reasoning-delta') accumulate(chunk.index, 'reasoning', chunk.text)
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
    case 'assistant/chunk':
      onChunk(event.data.chunk, event.time)
      return
    case 'assistant/message':
      closeAssistant()
      return
    case 'tool/result':
      addToolResult({ ...event.data, time: event.time })
      return
    case 'request/header': {
      const header = event.data.header
      plateModel.textContent = `${header.config.provider}/${header.config.model}`
      plateTools.textContent = String(header.tools?.length ?? 0)
      return
    }
    default:
  }
}

/* ---- host messages --------------------------------------------------- */

function apply(message) {
  switch (message.type) {
    case 'status':
      if (message.profile !== undefined) plateProfile.textContent = message.profile
      connection = message.state
      if (connection !== 'connected') working = false
      setPhase()
      return
    case 'welcome':
      connection = 'connected'
      setPhase()
      return
    case 'session':
      sessionId = message.sessionId
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
      return
    case 'error': {
      closeAssistant()
      const built = entry('fault', 'Fault', Date.now())
      const text = document.createElement('div')
      text.className = 'text'
      text.textContent = message.message
      built.body.appendChild(text)
      append(built.element)
      working = false
      setPhase()
      return
    }
    default:
  }
}

/* ---- composer -------------------------------------------------------- */

function submit() {
  const text = input.value.trim()
  if (text.length === 0 || sendButton.disabled) return
  input.value = ''
  input.style.height = 'auto'
  const built = entry('you', 'You', Date.now())
  const body = document.createElement('div')
  body.className = 'text'
  body.textContent = text
  built.body.appendChild(body)
  append(built.element)
  working = true
  setPhase()
  bridge.send({ type: 'prompt', text, ...(sessionId === undefined ? {} : { sessionId }) })
}

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

globalThis.dshRenderer = { apply }
bridge.onMessage(apply)
setPhase()
input.focus()
