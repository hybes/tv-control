const http = require('http')
const dgram = require('dgram')
const { execFile, execFileSync } = require('child_process')

// Panasonic Viera network remote: SOAP over HTTP on port 55000. This is the
// unencrypted protocol spoken by pre-2018 sets (e.g. TX-L55DT65B); 2018+ models
// need PIN pairing + AES and are only detected here (see probe), not driven.
const PORT = 55000
const URN_NRC = 'urn:panasonic-com:service:p00NetworkControl:1'
const URN_DMR = 'urn:schemas-upnp-org:service:RenderingControl:1'
const POWER_KEY = 'NRC_POWER-ONOFF'

// Same key names as IRCC_CODES in server.js, so the remote UI is shared.
const KEYS = {
  up: 'NRC_UP-ONOFF',
  down: 'NRC_DOWN-ONOFF',
  left: 'NRC_LEFT-ONOFF',
  right: 'NRC_RIGHT-ONOFF',
  confirm: 'NRC_ENTER-ONOFF',
  home: 'NRC_HOME-ONOFF',
  back: 'NRC_RETURN-ONOFF',
  volumeUp: 'NRC_VOLUP-ONOFF',
  volumeDown: 'NRC_VOLDOWN-ONOFF',
  mute: 'NRC_MUTE-ONOFF',
  display: 'NRC_INFO-ONOFF',
  input: 'NRC_CHG_INPUT-ONOFF',
  options: 'NRC_SUBMENU-ONOFF'
}

const POLL_MS = 2000
const ON_SETTLE_MS = 20000
const ON_TIMEOUT_MS = 60000
const OFF_SETTLE_MS = 15000
const OFF_TIMEOUT_MS = 40000
const INPUT_DELAY_MS = 3000
const MAX_TOGGLES = 2

const sleep = ms => new Promise(r => setTimeout(r, ms))

function request(ip, options, body) {
  return new Promise((resolve, reject) => {
    if (!ip) return reject(new Error('TV IP not configured'))
    const req = http.request({ hostname: ip, port: PORT, ...options }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

function soap(ip, path, urn, action, params, timeout = 5000) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${urn}">${params}</u:${action}></s:Body></s:Envelope>`
  return request(ip, {
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPACTION': `"${urn}#${action}"`,
      'Content-Length': Buffer.byteLength(body)
    },
    timeout
  }, body)
}

async function sendKey(config, key) {
  const res = await soap(config.tvIp, '/nrc/control_0', URN_NRC, 'X_SendKey', `<X_KeyEvent>${key}</X_KeyEvent>`)
  if (res.status !== 200) throw new Error(`TV rejected ${key} (HTTP ${res.status})`)
  return res
}

// There is no power-status call. The renderer service only answers properly while
// the panel is on, so: 200 = on, an HTTP error = standby with the network still up
// (the power key will wake it), no connection = off the network (or wrong IP).
async function getState(config) {
  try {
    const res = await soap(config.tvIp, '/dmr/control_0', URN_DMR, 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>', 3000)
    return res.status === 200 ? 'on' : 'standby'
  } catch {
    return 'unreachable'
  }
}

async function probe(config) {
  const state = await getState(config)
  if (state === 'unreachable') return { state }
  const get = p => request(config.tvIp, { path: p, method: 'GET', timeout: 4000 }).then(r => r.data, () => '')
  const [ddd, sdd] = await Promise.all([get('/nrc/ddd.xml'), get('/nrc/sdd_0.xml')])
  const model = (ddd.match(/<modelNumber>([^<]+)</) || ddd.match(/<friendlyName>([^<]+)</) || [])[1] || null
  return { state, model, encrypted: /X_GetEncryptSessionId/.test(sdd) }
}

function magicPacket(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) throw new Error(`invalid MAC address: ${mac}`)
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))])
}

function wake(mac) {
  return new Promise((resolve, reject) => {
    const packet = magicPacket(mac)
    const sock = dgram.createSocket('udp4')
    const done = err => { try { sock.close() } catch {} err ? reject(err) : resolve() }
    sock.once('error', done)
    sock.bind(() => {
      sock.setBroadcast(true)
      let left = 3
      const send = () => sock.send(packet, 9, '255.255.255.255', err => (err || --left === 0) ? done(err) : send())
      send()
    })
  })
}

// The kernel's neighbour table has the TV's MAC right after we've talked to it.
function lookupMac(ip) {
  try {
    const out = execFileSync('ip', ['neigh', 'show', ip], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const m = out.match(/lladdr ((?:[0-9a-f]{2}:){5}[0-9a-f]{2})/i)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

// HDMI-CEC through libcec's cec-client: the only discrete on/standby this TV has,
// and the only way to wake a set that drops its network connection in standby.
function cec(command) {
  return new Promise((resolve, reject) => {
    const child = execFile('cec-client', ['-s', '-d', '1'], { timeout: 15000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
    if (child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(command + '\n')
    }
  })
}

function cecInstalled() {
  try {
    execFileSync('which', ['cec-client'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function selectInput(config, log) {
  const port = config.tvHdmiPort || 2
  try {
    await sendKey(config, `NRC_HDMI${port}-ONOFF`)
    log(`HDMI ${port} selected`)
  } catch (e) {
    console.error('HDMI switch failed:', e.message)
    if (config.tvCec) await cec('as').catch(cecErr => console.error('HDMI-CEC active source failed:', cecErr.message))
  }
}

// The power key is a toggle, so power changes run one at a time and are gated on
// the state the TV last reported — a blind retry would switch it straight back.
let powerQueue = Promise.resolve()
function exclusive(fn) {
  const run = powerQueue.then(fn)
  powerQueue = run.catch(() => {})
  return run
}

let lastOnFailure = null

// Wake with whatever applies to the TV's current state: CEC (discrete) first,
// Wake-on-LAN while it is off the network, the power key once it answers in
// standby. Each attempt gets ON_SETTLE_MS before the next, because a booting set
// reads as standby for a while and a toggle then would turn it off again.
function on(config, log) {
  return exclusive(async () => {
    let state = await getState(config)
    if (state === 'on') {
      lastOnFailure = null
      await selectInput(config, log)
      return { ok: true }
    }
    // A set that can't be woken would otherwise log the same failure on every keepalive tick.
    const say = lastOnFailure === state ? () => {} : log
    if (state === 'unreachable' && !config.tvCec && !config.tvMac) {
      say('TV ON (panasonic): no answer from the TV and nothing to wake it with (no MAC for Wake-on-LAN, HDMI-CEC off)')
      lastOnFailure = state
      return { error: 'TV unreachable and no wake method configured' }
    }

    const deadline = Date.now() + ON_TIMEOUT_MS
    let lastAction = 0
    let toggles = 0
    let cecTried = false
    while (state !== 'on' && Date.now() < deadline) {
      if (Date.now() - lastAction >= ON_SETTLE_MS) {
        const sent = []
        if (config.tvCec && (state === 'unreachable' || !cecTried)) {
          cecTried = true
          await cec('on 0').then(() => sent.push('HDMI-CEC on'), e => say(`TV ON (panasonic): HDMI-CEC failed: ${e.message}`))
        }
        if (state === 'unreachable' && config.tvMac) {
          await wake(config.tvMac).then(() => sent.push('Wake-on-LAN'), e => say(`TV ON (panasonic): Wake-on-LAN failed: ${e.message}`))
        }
        // Re-read before toggling so one bad reply from a TV that is on can't switch it off.
        if (state === 'standby' && !sent.length && toggles < MAX_TOGGLES) {
          await sleep(1000)
          if (await getState(config) === 'standby') {
            toggles++
            await sendKey(config, POWER_KEY).then(() => sent.push('power key'), e => say(`TV ON (panasonic): ${e.message}`))
          }
        }
        if (sent.length) say(`TV ON (panasonic): TV is ${state}, sent ${sent.join(' + ')}`)
        lastAction = Date.now()
      }
      await sleep(POLL_MS)
      state = await getState(config)
    }

    if (state !== 'on') {
      say(`TV ON (panasonic): could not confirm power on (TV is ${state})`)
      lastOnFailure = state
      return { error: `TV did not turn on (${state})` }
    }
    lastOnFailure = null
    log('TV ON (panasonic): on')
    await sleep(INPUT_DELAY_MS)
    await selectInput(config, log)
    return { ok: true }
  })
}

function off(config, log) {
  return exclusive(async () => {
    let state = await getState(config)
    let lastAction = 0
    if (config.tvCec) {
      await cec('standby 0').then(() => {
        lastAction = Date.now()
        log('TV OFF (panasonic): sent HDMI-CEC standby')
      }, e => log(`TV OFF (panasonic): HDMI-CEC failed: ${e.message}`))
    } else if (state !== 'on') {
      log(`TV OFF (panasonic): already off (TV is ${state})`)
      return { ok: true }
    }

    const deadline = Date.now() + OFF_TIMEOUT_MS
    let toggles = 0
    while (state === 'on' && Date.now() < deadline) {
      if (toggles < MAX_TOGGLES && Date.now() - lastAction >= OFF_SETTLE_MS) {
        toggles++
        lastAction = Date.now()
        await sendKey(config, POWER_KEY).then(() => log('TV OFF (panasonic): sent power key'), e => log(`TV OFF (panasonic): ${e.message}`))
      }
      await sleep(POLL_MS)
      state = await getState(config)
    }

    if (state === 'on') {
      log('TV OFF (panasonic): could not confirm power off')
      return { error: 'TV did not turn off' }
    }
    log('TV OFF (panasonic): off')
    return { ok: true }
  })
}

module.exports = { KEYS, sendKey, getState, probe, on, off, magicPacket, lookupMac, cecInstalled }
