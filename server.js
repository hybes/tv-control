const express = require('express')
const { execSync, exec } = require('child_process')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const cron = require('node-cron')
const autologin = require('./autologin')

const app = express()
const PORT = 8080
const CONFIG_PATH = path.join(__dirname, 'config.json')
const logTs = msg => console.log(`[${new Date().toISOString()}] ${msg}`)

const defaultConfig = {
  url: 'https://google.com',
  scheduleEnabled: true,
  tvOnTime: '08:45',
  tvOffTime: '17:00',
  scheduleDays: [0, 1, 2, 3],
  dateOverrides: {},
  tvIp: '',
  tvPsk: '',
  keepaliveSec: 150,
  wakeDelaySec: 5,
  networkScannerUrl: 'http://bh-server:8840',
  sonosControlEnabled: false,
  sonosIp: '',
  autoLoginEnabled: true,
  autoLoginCheckSec: 30,
  loginHost: 'login.teleflow.app',
  loginCredentialOrigin: 'login.teleflow.app',
  chromeProfile: '/home/hybes/.config/chromium-kiosk',
  loginUsername: '',
  loginPassword: ''
}

function migrateConfig(config) {
  if (config.weekendsEnabled !== undefined && !config.scheduleDays) {
    config.scheduleDays = config.weekendsEnabled ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3]
    delete config.weekendsEnabled
  }
  if (!config.scheduleDays) config.scheduleDays = [0, 1, 2, 3]
  if (!config.dateOverrides) config.dateOverrides = {}
  if (typeof config.keepaliveSec !== 'number' || config.keepaliveSec < 30) config.keepaliveSec = 150
  if (typeof config.wakeDelaySec !== 'number' || config.wakeDelaySec < 0) config.wakeDelaySec = 5
  if (typeof config.networkScannerUrl !== 'string') config.networkScannerUrl = defaultConfig.networkScannerUrl
  if (typeof config.sonosControlEnabled !== 'boolean') config.sonosControlEnabled = false
  if (typeof config.sonosIp !== 'string') config.sonosIp = ''
  if (typeof config.autoLoginEnabled !== 'boolean') config.autoLoginEnabled = true
  if (typeof config.autoLoginCheckSec !== 'number' || config.autoLoginCheckSec < 10) config.autoLoginCheckSec = 30
  if (typeof config.loginHost !== 'string') config.loginHost = defaultConfig.loginHost
  if (typeof config.loginCredentialOrigin !== 'string') config.loginCredentialOrigin = defaultConfig.loginCredentialOrigin
  if (typeof config.chromeProfile !== 'string') config.chromeProfile = defaultConfig.chromeProfile
  if (typeof config.loginUsername !== 'string') config.loginUsername = ''
  if (typeof config.loginPassword !== 'string') config.loginPassword = ''
  return config
}
let onJob = null
let offJob = null
let keepaliveTimer = null

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return migrateConfig(config)
  } catch {
    saveConfig(defaultConfig)
    return { ...defaultConfig }
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function runCmd(cmd) {
  try {
    return execSync(cmd, { timeout: 10000 }).toString().trim()
  } catch (e) {
    return e.stderr ? e.stderr.toString().trim() : e.message
  }
}

function fetchJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(url) } catch (e) { return reject(e) }
    const lib = parsed.protocol === 'https:' ? https : http
    const req = lib.get(url, {
      timeout,
      headers: { Accept: '*/*' },
      rejectUnauthorized: false
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function getNetworkHosts() {
  const config = loadConfig()
  const base = (config.networkScannerUrl || '').replace(/\/$/, '')
  if (!base) return { ok: false, error: 'Network scanner URL not configured', devices: [] }
  try {
    const data = await fetchJson(`${base}/api/all`)
    const devices = Array.isArray(data) ? data : []
    devices.sort((a, b) => (b.Now || 0) - (a.Now || 0) || (a.IP || '').localeCompare(b.IP || ''))
    return { ok: true, devices, online: devices.filter(d => d.Now === 1).length }
  } catch (e) {
    return { ok: false, error: e.message, devices: [] }
  }
}

function sonosAvTransport(ip, action) {
  const inner = action === 'Play'
    ? `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>`
    : `<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:${action}>`
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip,
      port: 1400,
      path: '/MediaRenderer/AVTransport/Control',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

async function discoverSonosIps(config) {
  const manual = (config.sonosIp || '').trim()
  if (manual) return [manual]
  const hosts = await getNetworkHosts()
  if (!hosts.ok) return []
  return [...new Set(hosts.devices
    .filter(d => /sonos/i.test(d.Hw || '') || /sonos/i.test(d.Name || '') || /sonos/i.test(d.DNS || ''))
    .map(d => d.IP)
    .filter(Boolean))]
}

async function controlSonos(action, config = loadConfig()) {
  const ips = await discoverSonosIps(config)
  if (!ips.length) {
    return { ok: false, error: 'No Sonos players found', results: [] }
  }
  const results = []
  for (const ip of ips) {
    try {
      const result = await sonosAvTransport(ip, action)
      console.log(`[${new Date().toISOString()}] Sonos ${action.toLowerCase()} ${ip}: HTTP ${result.status}`)
      results.push({ ip, ok: result.status === 200 })
    } catch (e) {
      console.error(`Sonos ${action.toLowerCase()} ${ip} failed:`, e.message)
      results.push({ ip, ok: false, error: e.message })
    }
  }
  return { ok: results.some(r => r.ok), results }
}

async function stopSonosAtSchedule(config = loadConfig()) {
  if (!config.sonosControlEnabled) return
  await controlSonos('Stop', config)
}

function sonyApi(config, method, params = [], apiPath = '/sony/system') {
  return new Promise((resolve, reject) => {
    if (!config.tvIp || !config.tvPsk) return reject(new Error('TV IP or PSK not configured'))
    const postData = JSON.stringify({ method, id: 1, params, version: '1.0' })
    const req = http.request({
      hostname: config.tvIp,
      port: 80,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-PSK': config.tvPsk,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 8000
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(data) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(postData)
    req.end()
  })
}

const IRCC_CODES = {
  up: 'AAAAAQAAAAEAAAB0Aw==',
  down: 'AAAAAQAAAAEAAAB1Aw==',
  left: 'AAAAAQAAAAEAAAA0Aw==',
  right: 'AAAAAQAAAAEAAAAzAw==',
  confirm: 'AAAAAQAAAAEAAABlAw==',
  home: 'AAAAAQAAAAEAAABgAw==',
  back: 'AAAAAgAAAJcAAAAjAw==',
  volumeUp: 'AAAAAQAAAAEAAAASAw==',
  volumeDown: 'AAAAAQAAAAEAAAATAw==',
  mute: 'AAAAAQAAAAEAAAAUAw==',
  display: 'AAAAAQAAAAEAAAA6Aw==',
  input: 'AAAAAQAAAAEAAAAlAw==',
  options: 'AAAAAgAAAJcAAAA2Aw=='
}

function ircc(config, code) {
  return new Promise((resolve, reject) => {
    if (!config.tvIp || !config.tvPsk) return reject(new Error('TV IP or PSK not configured'))
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`
    const req = http.request({
      hostname: config.tvIp,
      port: 80,
      path: '/sony/IRCC',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPACTION': '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
        'X-Auth-PSK': config.tvPsk,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 8000
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

async function tvOn() {
  const config = loadConfig()
  try {
    const result = await sonyApi(config, 'setPowerStatus', [{ status: true }])
    console.log(`[${new Date().toISOString()}] TV ON:`, JSON.stringify(result))
    await new Promise(r => setTimeout(r, 3000))
    try {
      const inputResult = await sonyApi(config, 'setPlayContent', [{ uri: 'extInput:hdmi?port=2' }], '/sony/avContent')
      console.log(`[${new Date().toISOString()}] HDMI switch:`, JSON.stringify(inputResult))
    } catch (inputErr) {
      console.error('HDMI switch failed:', inputErr.message)
    }
    return result
  } catch (e) {
    console.error('TV ON failed:', e.message)
    return { error: e.message }
  }
}

async function tvOff() {
  const config = loadConfig()
  try {
    const result = await sonyApi(config, 'setPowerStatus', [{ status: false }])
    console.log(`[${new Date().toISOString()}] TV OFF:`, JSON.stringify(result))
    return result
  } catch (e) {
    console.error('TV OFF failed:', e.message)
    return { error: e.message }
  }
}

async function getTvPowerStatus() {
  const config = loadConfig()
  try {
    const result = await sonyApi(config, 'getPowerStatus')
    return result?.result?.[0]?.status === 'active'  } catch {
    return null
  }
}

function getActiveDisplay() {
  try {
    execSync('DISPLAY=:0 xdpyinfo >/dev/null 2>&1', { timeout: 3000 })
    return ':0'
  } catch {
    try {
      execSync('DISPLAY=:1 xdpyinfo >/dev/null 2>&1', { timeout: 3000 })
      return ':1'
    } catch {
      return ':0'
    }
  }
}

function launchChrome(url) {
  exec('pkill -f "chromium.*kiosk" || true')
  setTimeout(() => {
    const display = getActiveDisplay()
    const cmd = `DISPLAY=${display} chromium --kiosk --no-first-run --disable-translate --disable-infobars --disable-suggestions-service --disable-save-password-bubble --disable-session-crashed-bubble --noerrdialogs --disable-features=TranslateUI --start-fullscreen --window-size=1920,1080 --window-position=0,0 --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --remote-allow-origins=* --user-data-dir=/home/hybes/.config/chromium-kiosk "${url}" &`
    exec(cmd, { env: { ...process.env, DISPLAY: display } })
    console.log(`[${new Date().toISOString()}] Chrome launched on ${display}: ${url}`)
  }, 1000)
}
function killChrome() {
  runCmd('pkill -f "chromium.*kiosk" || true')
}

function getChromeStatus() {
  try {
    const result = runCmd('pgrep -f "chromium.*kiosk"')
    return result.length > 0
  } catch {
    return false
  }
}

function parseCronTime(timeStr) {
  const [hours, minutes] = timeStr.split(':')
  return { hours, minutes }
}

function setupSchedule() {
  if (onJob) { onJob.stop(); onJob = null }
  if (offJob) { offJob.stop(); offJob = null }

  const config = loadConfig()
  if (!config.scheduleEnabled) return

  const onTime = parseCronTime(config.tvOnTime)
  const offTime = parseCronTime(config.tvOffTime)
  onJob = cron.schedule(`${onTime.minutes} ${onTime.hours} * * *`, async () => {
    const cfg = loadConfig()
    if (!isTodayActive(cfg)) {
      console.log(`[${new Date().toISOString()}] Schedule: skipping today (not active)`)
      return
    }
    console.log(`[${new Date().toISOString()}] Schedule: TV ON + Chrome launch`)
    await tvOn()
    setTimeout(() => launchChrome(cfg.url), (cfg.wakeDelaySec || 5) * 1000)
  })

  offJob = cron.schedule(`${offTime.minutes} ${offTime.hours} * * *`, async () => {
    const cfg = loadConfig()
    if (!isTodayActive(cfg)) return
    console.log(`[${new Date().toISOString()}] Schedule: TV OFF + Chrome kill`)
    killChrome()
    setTimeout(() => tvOff(), 2000)
    if (cfg.sonosControlEnabled) {
      stopSonosAtSchedule(cfg).catch(e => console.error('Sonos stop failed:', e.message))
    }
  })

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const activeDays = (config.scheduleDays || [0, 1, 2, 3]).map(d => dayNames[d]).join(', ')
  console.log(`Schedule active: ON at ${config.tvOnTime}, OFF at ${config.tvOffTime} (days: ${activeDays})`)
  setupKeepalive()
}
function isTodayActive(config) {
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  if (config.dateOverrides && config.dateOverrides[dateStr] !== undefined) {
    return config.dateOverrides[dateStr]
  }

  const jsDay = now.getDay()
  const schedDay = jsDay === 0 ? 6 : jsDay - 1
  return (config.scheduleDays || [0, 1, 2, 3]).includes(schedDay)
}

function isTvScheduledOn() {
  const config = loadConfig()
  if (!config.scheduleEnabled) return false
  if (!isTodayActive(config)) return false

  const now = new Date()
  const currentMins = now.getHours() * 60 + now.getMinutes()
  const [onH, onM] = config.tvOnTime.split(':').map(Number)
  const [offH, offM] = config.tvOffTime.split(':').map(Number)
  const onMins = onH * 60 + onM
  const offMins = offH * 60 + offM

  return currentMins >= onMins && currentMins < offMins
}
function setupKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null }

  const config = loadConfig()
  const intervalSec = Math.max(30, config.keepaliveSec || 150)

  keepaliveTimer = setInterval(async () => {
    if (!isTvScheduledOn()) return

    const isOn = await getTvPowerStatus()
    if (isOn === false) {
      console.log(`[${new Date().toISOString()}] Keepalive: TV in standby during scheduled hours, waking up`)
      await tvOn()
    } else if (isOn === true) {
      const cfg = loadConfig()
      try {
        await ircc(cfg, IRCC_CODES.right)
      } catch (e) {
        console.error('Keepalive IRCC failed:', e.message)
      }
    }
  }, intervalSec * 1000)

  const mins = Math.floor(intervalSec / 60)
  const secs = intervalSec % 60
  console.log(`TV keepalive active (every ${mins}m${secs}s during scheduled hours, IRCC idle-reset)`)
}

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.get('/api/config', (req, res) => {
  res.json(loadConfig())
})

app.post('/api/config', (req, res) => {
  const config = { ...loadConfig(), ...req.body }
  saveConfig(config)
  setupSchedule()
  autologin.startWatcher(loadConfig, logTs)
  res.json({ ok: true, config })
})

app.post('/api/relogin', async (req, res) => {
  const result = await autologin.reloginNow(loadConfig, logTs)
  res.json({ ok: result.ok, message: result.ok ? `Signed in as ${result.username}` : `Re-login failed: ${result.reason}`, result })
})

app.get('/api/status', async (req, res) => {
  const tvPower = await getTvPowerStatus()
  const display = getDisplayInfo()
  const primaryKey = Object.keys(display.connectors).find(k => display.connectors[k].status === 'connected') || Object.keys(display.connectors)[0] || null
  const primary = primaryKey ? display.connectors[primaryKey] : null
  const activeVt = (readSys('/sys/class/tty/tty0/active') || '').replace('tty', '')
  const chromeRunning = getChromeStatus()
  const onKioskVt = activeVt === String(KIOSK_VT)
  const connected = primary && primary.status === 'connected'
  const powered = primary && primary.dpms === 'On'
  const cfg = loadConfig()
  res.json({
    chrome: chromeRunning,
    tv: tvPower,
    scheduleActive: cfg.scheduleEnabled,
    autoLogin: { enabled: cfg.autoLoginEnabled !== false, ...autologin.getStatus() },
    display: primary ? {
      connector: primaryKey,
      status: primary.status,
      dpms: primary.dpms,
      edid: primary.edidBytes > 0,
      vt: activeVt,
      kioskVt: onKioskVt,
      live: connected && powered && onKioskVt && chromeRunning
    } : null
  })
})

app.post('/api/chrome/start', (req, res) => {
  const config = loadConfig()
  launchChrome(config.url)
  res.json({ ok: true, message: 'Chrome starting' })
})

app.post('/api/chrome/stop', (req, res) => {
  killChrome()
  res.json({ ok: true, message: 'Chrome stopped' })
})
app.post('/api/chrome/restart', (req, res) => {
  const config = loadConfig()
  killChrome()
  setTimeout(() => launchChrome(config.url), 1500)
  res.json({ ok: true, message: 'Chrome restarting' })
})

app.post('/api/chrome/clear-cache', (req, res) => {
  const cfg = loadConfig()
  killChrome()
  setTimeout(() => {
    const profile = '/home/hybes/.config/chromium-kiosk'
    const targets = [
      'Default/Cache',
      'Default/Code Cache',
      'Default/GPUCache',
      'Default/Service Worker',
      'Default/Application Cache',
      'Default/Local Storage',
      'Default/Session Storage',
      'Default/IndexedDB',
      'Default/WebStorage',
      'Default/blob_storage',
      'Default/Site Characteristics Database',
      'ShaderCache',
      'GrShaderCache'
    ]
    for (const t of targets) {
      runCmd(`rm -rf "${profile}/${t}"`)
    }
    const sep = cfg.url.includes('?') ? '&' : '?'
    const bustedUrl = `${cfg.url}${sep}_cb=${Date.now()}`
    console.log(`[${new Date().toISOString()}] Cache cleared, relaunching with: ${bustedUrl}`)
    setTimeout(() => launchChrome(bustedUrl), 800)
  }, 1000)
  res.json({ ok: true, message: 'Cache + storage cleared, Chrome restarting' })
})

app.post('/api/tv/on', async (req, res) => {
  await tvOn()
  res.json({ ok: true, message: 'TV turning on' })
})

app.post('/api/tv/off', async (req, res) => {
  await tvOff()
  res.json({ ok: true, message: 'TV turning off' })
})

app.post('/api/tv/remote/:key', async (req, res) => {
  const key = req.params.key
  const code = IRCC_CODES[key]
  if (!code) return res.status(400).json({ ok: false, message: `Unknown remote key: ${key}` })
  try {
    await ircc(loadConfig(), code)
    res.json({ ok: true })
  } catch (e) {
    res.json({ ok: false, message: `Remote failed: ${e.message}` })
  }
})

app.post('/api/launch', async (req, res) => {
  const config = loadConfig()
  await tvOn()
  setTimeout(() => launchChrome(config.url), (config.wakeDelaySec || 5) * 1000)
  res.json({ ok: true, message: 'TV on + Chrome launching' })
})

app.post('/api/shutdown', async (req, res) => {
  killChrome()
  setTimeout(() => tvOff(), 2000)
  res.json({ ok: true, message: 'Chrome killed + TV off' })
})

function readSys(p) {
  try { return fs.readFileSync(p, 'utf8').trim() } catch { return null }
}

function getDisplayInfo() {
  const connectors = {}
  try {
    const entries = fs.readdirSync('/sys/class/drm')
    for (const name of entries) {
      if (!/^card\d+-/.test(name)) continue
      const base = `/sys/class/drm/${name}`
      const key = name.replace(/^card\d+-/, '')
      let edidBytes = 0
      try { edidBytes = fs.statSync(`${base}/edid`).size } catch {}
      connectors[key] = {
        status: readSys(`${base}/status`),
        enabled: readSys(`${base}/enabled`),
        dpms: readSys(`${base}/dpms`),
        edidBytes
      }
    }
  } catch {}
  return { connectors, fb0Mode: readSys('/sys/class/graphics/fb0/modes') }
}

const KIOSK_VT = 7

async function displayKick() {
  runCmd('sudo chvt 1')
  await new Promise(r => setTimeout(r, 1500))
  runCmd(`sudo chvt ${KIOSK_VT}`)
}

async function displayReset() {
  console.log(`[${new Date().toISOString()}] Display reset: killing chrome + restarting gdm`)
  killChrome()
  await new Promise(r => setTimeout(r, 1200))
  runCmd('sudo systemctl restart gdm')
  await new Promise(r => setTimeout(r, 9000))
  runCmd(`sudo chvt ${KIOSK_VT}`)
  await new Promise(r => setTimeout(r, 1500))
  const config = loadConfig()
  launchChrome(config.url)
  console.log(`[${new Date().toISOString()}] Display reset: on VT ${KIOSK_VT}, chrome relaunched`)
}

app.get('/api/display/status', (req, res) => {
  res.json(getDisplayInfo())
})

app.post('/api/display/kick', (req, res) => {
  displayKick().catch(e => console.error('displayKick failed:', e.message))
  res.json({ ok: true, message: 'VT kick issued' })
})

app.post('/api/display/reset', (req, res) => {
  displayReset().catch(e => console.error('displayReset failed:', e.message))
  res.json({ ok: true, message: 'Display resetting...' })
})

app.get('/api/network/hosts', async (req, res) => {
  res.json(await getNetworkHosts())
})

app.post('/api/sonos/play', async (req, res) => {
  res.json(await controlSonos('Play'))
})

app.post('/api/sonos/pause', async (req, res) => {
  res.json(await controlSonos('Pause'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard manager running on http://0.0.0.0:${PORT}`)
  setupSchedule()
  autologin.startWatcher(loadConfig, logTs)
})