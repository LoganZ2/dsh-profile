/**
 * Electron main — the desktop host. Spawns the harness as a child process
 * (`dsh --profile loganz2 --patch desktop.patch.yml`), connects to the bridge
 * socket, and relays NDJSON lines to/from the renderer over IPC. The harness
 * neither knows nor cares that Electron exists.
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const net = require('node:net')
const { homedir, tmpdir } = require('node:os')
const path = require('node:path')

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? process.env.DSH_HOME
  : path.join(homedir(), '.dsh')

const SOCKET = path.join(
  tmpdir(),
  `dsh-bridge-${createHash('sha256').update(path.resolve(DSH_HOME)).digest('hex').slice(0, 8)}.sock`,
)

const PROFILE = 'loganz2'

let harness
let socket
let win

/** Host-level messages ride the same channel as the bridge's own NDJSON. */
function post(message) {
  if (win && !win.isDestroyed()) win.webContents.send('bridge:message', JSON.stringify(message))
}

function startHarness() {
  harness = spawn('dsh', ['--profile', PROFILE, '--patch', path.join(__dirname, 'desktop.patch.yml')], {
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  harness.stdout.on('data', d => console.log('[harness]', d.toString().trimEnd()))
  harness.stderr.on('data', d => console.error('[harness]', d.toString().trimEnd()))
  harness.on('exit', (code) => {
    console.error(`[harness] exited with ${code}`)
    harness = undefined
    post({ type: 'status', state: 'stopped' })
  })
}

function connect(attempt = 0) {
  socket = net.createConnection(SOCKET)
  let buffered = ''
  socket.on('connect', () => {
    console.log('[bridge] connected', SOCKET)
    post({ type: 'status', state: 'connected', profile: PROFILE })
  })
  socket.on('data', (chunk) => {
    buffered += chunk.toString()
    let index
    while ((index = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (line.trim() && win && !win.isDestroyed()) win.webContents.send('bridge:message', line)
    }
  })
  socket.on('error', () => {
    if (attempt < 60) setTimeout(() => connect(attempt + 1), 500)
    else {
      console.error('[bridge] could not connect to', SOCKET)
      post({ type: 'status', state: 'stopped' })
    }
  })
}

ipcMain.on('bridge:send', (_event, line) => {
  if (socket && !socket.destroyed) socket.write(`${line}\n`)
})

app.whenReady().then(() => {
  startHarness()
  win = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 780,
    title: 'dsh',
    show: false,
    backgroundColor: '#dad6cb',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  connect()
})

app.on('window-all-closed', () => {
  if (harness) harness.kill()
  app.quit()
})
