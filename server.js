const express = require('express')
const { execSync, exec, execFileSync } = require('child_process')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const cron = require('node-cron')
const autologin = require('./autologin')
const panasonic = require('./panasonic')

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
  timezone: 'Europe/London',
  reconcileSec: 30,
  tvType: 'sony',
  tvIp: '',
  tvPsk: '',
  tvHdmiPort: 2,
  tvMac: '',
  tvCec: false,
  tvWakeOk: null,
  tvOffMode: 'standby',
  tvScreenOffKeys: [],
  tvScreenOffKeysCold: [],
  tvMenuAt: 'unknown',
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
  if (typeof config.timezone !== 'string' || !config.timezone) config.timezone = defaultConfig.timezone
  if (typeof config.reconcileSec !== 'number' || config.reconcileSec < 15) config.reconcileSec = 30
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
  if (!['sony', 'panasonic'].includes(config.tvType)) config.tvType = 'sony'
  if (![1, 2, 3, 4].includes(config.tvHdmiPort)) config.tvHdmiPort = 2
  if (typeof config.tvMac !== 'string') config.tvMac = ''
  if (typeof config.tvCec !== 'boolean') config.tvCec = false
  if (typeof config.tvWakeOk !== 'boolean') config.tvWakeOk = null
  if (!['standby', 'screen'].includes(config.tvOffMode)) config.tvOffMode = 'standby'
  for (const field of ['tvScreenOffKeys', 'tvScreenOffKeysCold']) {
    config[field] = (Array.isArray(config[field]) ? config[field] : []).filter(k => Object.hasOwn(panasonic.KEYS, k))
  }
  if (!['screen-display', 'top', 'unknown'].includes(config.tvMenuAt)) config.tvMenuAt = 'unknown'
  delete config.tvMenuDirty
  return config
}
let onJob = null
let offJob = null
let keepaliveTimer = null
let reconcileTimer = null
let reconcileRunning = false
let lastScheduledDesired = null
let lastRemoteKeyAt = 0
let lastLinkRetrainAt = 0
let tvScreenOff = false
let tvSeenOffAt = 0
let linkSeenDownAt = 0

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

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function switchToHdmi(config) {
  try {
    const inputResult = await sonyApi(config, 'setPlayContent', [{ uri: `extInput:hdmi?port=${config.tvHdmiPort}` }], '/sony/avContent')
    logTs(`HDMI switch: ${JSON.stringify(inputResult)}`)
  } catch (inputErr) {
    console.error('HDMI switch failed:', inputErr.message)
  }
}

// Turn the TV on and switch to the kiosk's HDMI input. With verify=true (the
// default) it polls getPowerStatus and re-issues the power-on if the panel hasn't
// actually woken — Sony Bravias frequently ACK setPowerStatus without leaving deep
// standby. Panasonic sets have their own sequence (toggle-only power key).
async function tvOn({ verify = true } = {}) {
  const config = loadConfig()
  if (config.tvType === 'panasonic') {
    const result = await panasonic.on(config, logTs)
    // Remember whether this set can be brought back from standby (see tvOff). Only a
    // wake by power key clears a recorded failure; anything else is ambiguous.
    const wakeOk = result.woke ? true : result.error ? false : null
    if (wakeOk !== null && wakeOk !== config.tvWakeOk) saveConfig({ ...loadConfig(), tvWakeOk: wakeOk })
    if (!result.error) tvScreenOff = false
    return result
  }
  try {
    const result = await sonyApi(config, 'setPowerStatus', [{ status: true }])
    logTs(`TV ON: ${JSON.stringify(result)}`)
    await sleep(3000)
    await switchToHdmi(config)
    if (verify) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await sleep(2500)
        const status = await getTvPowerStatus()
        if (status === true) return result
        logTs(`TV ON verify ${attempt}/3: status=${status}; re-issuing power on`)
        try {
          await sonyApi(config, 'setPowerStatus', [{ status: true }])
          await sleep(1500)
          await switchToHdmi(config)
        } catch (retryErr) {
          console.error('TV ON retry failed:', retryErr.message)
        }
      }
      const finalStatus = await getTvPowerStatus()
      if (finalStatus !== true) {
        logTs(`TV ON: could not confirm power on (status=${finalStatus}); TV may be unreachable in deep standby`)
      }
    }
    return result
  } catch (e) {
    console.error('TV ON failed:', e.message)
    return { error: e.message }
  }
}

// scheduled=true is the end-of-day off. A Viera that could not be woken last time
// is left on then: switching it off would leave the screen dark until someone
// presses the button on the set. A manual off still goes through.
async function tvOff({ verify = true, scheduled = false } = {}) {
  const config = loadConfig()
  if (config.tvType === 'panasonic') {
    // Screen-off mode never uses standby, so nothing can be stranded. Its key presses
    // are blind, though, and must match where the TV menu was last left (tvMenuAt):
    // on Screen Display after our own screen-off, at the top after a power cycle,
    // unknown once a person has opened the menu.
    if (config.tvOffMode === 'screen') {
      if (config.tvMenuAt === 'unknown') {
        logTs('TV screen off skipped: the TV menu has been used since the last screen-off, so the saved key presses may land in the wrong place (re-sync from the portal)')
        return { error: 'TV menu was used since the last screen-off; re-sync it from the Remote panel first' }
      }
      const cold = config.tvMenuAt === 'top'
      const result = await panasonic.screenOff(config, cold ? config.tvScreenOffKeysCold : config.tvScreenOffKeys, logTs)
      if (result.screenOff) {
        tvScreenOff = true
        if (cold) saveConfig({ ...loadConfig(), tvMenuAt: 'screen-display' })
      }
      return result
    }
    if (scheduled && config.tvWakeOk === false) {
      logTs('TV OFF skipped: this TV could not be switched on from standby last time, so it is left on (TV Off then TV On from the portal re-tests it)')
      return { ok: true, skipped: true }
    }
    return panasonic.off(config, logTs)
  }
  try {
    const result = await sonyApi(config, 'setPowerStatus', [{ status: false }])
    logTs(`TV OFF: ${JSON.stringify(result)}`)
    if (verify) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await sleep(2000)
        const status = await getTvPowerStatus()
        // null = unreachable, which for a TV powering down means it's effectively off
        if (status === false || status === null) return result
        logTs(`TV OFF verify ${attempt}/3: status=${status}; re-issuing power off`)
        try {
          await sonyApi(config, 'setPowerStatus', [{ status: false }])
        } catch (retryErr) {
          console.error('TV OFF retry failed:', retryErr.message)
        }
      }
    }
    return result
  } catch (e) {
    console.error('TV OFF failed:', e.message)
    return { error: e.message }
  }
}

// true = on, false = standby, null = no answer. A Viera in standby usually drops
// off the network, so for Panasonic null is the normal "off" reading.
async function getTvPowerStatus() {
  const config = loadConfig()
  if (config.tvType === 'panasonic') {
    const state = await panasonic.getState(config)
    return state === 'on' ? true : state === 'standby' ? false : null
  }
  try {
    const result = await sonyApi(config, 'getPowerStatus')
    return result?.result?.[0]?.status === 'active'  } catch {
    return null
  }
}

function remoteKeys(config) {
  return config.tvType === 'panasonic' ? panasonic.KEYS : IRCC_CODES
}

function sendRemoteKey(config, key) {
  if (config.tvType === 'panasonic') return panasonic.sendKey(config, panasonic.KEYS[key])
  return ircc(config, IRCC_CODES[key])
}

// Wake-on-LAN needs the TV's MAC, which can only be read while it is on the network.
function learnTvMac(config) {
  if (config.tvMac || !config.tvIp) return null
  const mac = panasonic.lookupMac(config.tvIp)
  if (!mac) return null
  saveConfig({ ...loadConfig(), tvMac: mac })
  logTs(`Learned TV MAC ${mac} for Wake-on-LAN`)
  return mac
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
    const cmd = `ulimit -c 0; DISPLAY=${display} chromium --kiosk --no-first-run --disable-translate --disable-infobars --disable-suggestions-service --disable-save-password-bubble --disable-session-crashed-bubble --noerrdialogs --disable-features=TranslateUI --start-fullscreen --window-size=1920,1080 --window-position=0,0 --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --remote-allow-origins=* --user-data-dir=/home/hybes/.config/chromium-kiosk "${url}" &`
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

async function applyScheduledOn(reason, { forceChrome = false } = {}) {
  const cfg = loadConfig()
  logTs(`Scheduled ON (${reason}): TV on + Chrome launch`)
  await tvOn()
  // At the real morning tick, force a fresh browser. On a mid-window restart,
  // leave an already-running kiosk alone and only launch if it's down.
  if (forceChrome || !getChromeStatus()) launchChrome(cfg.url)
}

async function applyScheduledOff(reason) {
  const cfg = loadConfig()
  logTs(`Scheduled OFF (${reason}): Chrome kill + TV off`)
  killChrome()
  await sleep(2000)
  await tvOff({ scheduled: true })
  if (cfg.sonosControlEnabled) {
    stopSonosAtSchedule(cfg).catch(e => console.error('Sonos stop failed:', e.message))
  }
}

// Single source of truth for scheduled state. Runs on every cron edge, on a
// periodic timer, and at startup — so a missed cron fire (process restart), a
// crashed Chrome, or a TV that ignored its power command all get corrected on
// the next tick instead of waiting until tomorrow. A mutex + in-memory edge
// tracker keep repeated calls idempotent.
async function reconcile(reason) {
  if (reconcileRunning) return
  reconcileRunning = true
  try {
    const cfg = loadConfig()
    if (!cfg.scheduleEnabled) { lastScheduledDesired = null; return }

    const shouldBeOn = isTvScheduledOn()
    const wasOn = lastScheduledDesired === true
    lastScheduledDesired = shouldBeOn

    if (shouldBeOn) {
      if (!wasOn) {
        // Entering the window — covers the exact cron tick and catch-up after a
        // mid-window restart (wasOn starts null). Only the real morning tick
        // forces a fresh browser; restarts leave a live kiosk untouched.
        await applyScheduledOn(reason, { forceChrome: reason === 'cron-on' })
        return
      }
      // Already in the window: self-heal if Chrome died (page crash, killed, etc.)
      if (!getChromeStatus()) {
        logTs(`Reconcile(${reason}): Chrome not running during scheduled hours, relaunching`)
        launchChrome(cfg.url)
      }
      await healDisplayLink()
    } else if (wasOn) {
      // Leaving the window — reliable shutdown even if the OFF cron tick was missed.
      await applyScheduledOff(reason)
    }
  } catch (e) {
    console.error('Reconcile failed:', e.message)
  } finally {
    reconcileRunning = false
  }
}

function setupSchedule() {
  if (onJob) { onJob.stop(); onJob = null }
  if (offJob) { offJob.stop(); offJob = null }
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }

  const config = loadConfig()
  if (!config.scheduleEnabled) {
    lastScheduledDesired = null
    console.log('Schedule disabled')
    return
  }

  const tz = config.timezone || 'Europe/London'
  const onTime = parseCronTime(config.tvOnTime)
  const offTime = parseCronTime(config.tvOffTime)
  onJob = cron.schedule(`${onTime.minutes} ${onTime.hours} * * *`, () => reconcile('cron-on'), { timezone: tz })
  offJob = cron.schedule(`${offTime.minutes} ${offTime.hours} * * *`, () => reconcile('cron-off'), { timezone: tz })

  const reconcileMs = Math.max(15, config.reconcileSec || 30) * 1000
  reconcileTimer = setInterval(() => reconcile('loop'), reconcileMs)
  setTimeout(() => reconcile('startup'), 3000)

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const activeDays = (config.scheduleDays || [0, 1, 2, 3]).map(d => dayNames[d]).join(', ')
  console.log(`Schedule active (${tz}): ON at ${config.tvOnTime}, OFF at ${config.tvOffTime} (days: ${activeDays}); reconcile every ${reconcileMs / 1000}s`)
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
    const cfg = loadConfig()
    const viera = cfg.tvType === 'panasonic'
    // A Viera that can't be woken is left on round the clock (see tvOff), so its idle
    // timer needs resetting out of hours too, or its auto-standby strands it off.
    // (Not in screen-off mode: there any key press would switch the panel back on.)
    const inHours = isTvScheduledOn()
    if (!inHours && !(viera && cfg.tvWakeOk === false && cfg.tvOffMode !== 'screen')) return

    const isOn = await getTvPowerStatus()
    if (viera ? isOn !== true : isOn === false) {
      if (!inHours) return
      // tvOn logs its own progress for Panasonic (and stays quiet while a wake keeps failing)
      if (!viera) console.log(`[${new Date().toISOString()}] Keepalive: TV in standby during scheduled hours, waking up`)
      await tvOn()
    } else if (isOn === true) {
      if (viera) learnTvMac(cfg)
      // On a Viera "right" changes whatever a settings menu has highlighted, so nudge
      // with Exit, and not at all while someone is using the portal remote.
      if (viera && Date.now() - lastRemoteKeyAt < 5 * 60 * 1000) return
      try {
        await sendRemoteKey(cfg, viera ? 'exit' : 'right')
        tvScreenOff = false
      } catch (e) {
        console.error('Keepalive key failed:', e.message)
      }
    }
  }, intervalSec * 1000)

  const mins = Math.floor(intervalSec / 60)
  const secs = intervalSec % 60
  console.log(`TV keepalive active (every ${mins}m${secs}s during scheduled hours, remote-key idle-reset)`)
}

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.get('/api/config', (req, res) => {
  res.json(loadConfig())
})

app.post('/api/config', (req, res) => {
  // tvWakeOk and tvMenuAt are recorded by the server; a stale copy from an open page must not undo them
  const { tvWakeOk, tvMenuAt, tvMenuDirty, ...body } = req.body || {}
  const config = { ...loadConfig(), ...body }
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
    tvType: cfg.tvType,
    tvScreen: cfg.tvType === 'panasonic' && cfg.tvOffMode === 'screen' ? (tvScreenOff ? 'off' : 'on') : null,
    tvMenuDirty: cfg.tvType === 'panasonic' && cfg.tvOffMode === 'screen' && cfg.tvMenuAt === 'unknown',
    scheduleActive: cfg.scheduleEnabled,
    autoLogin: { enabled: cfg.autoLoginEnabled !== false, ...autologin.getStatus() },
    display: primary ? {
      connector: primaryKey,
      status: primary.status,
      dpms: primary.dpms,
      link: primary.link,
      edid: primary.edidBytes > 0,
      vt: activeVt,
      kioskVt: onKioskVt,
      live: connected && powered && primary.link !== false && onKioskVt && chromeRunning
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
  const result = await tvOn()
  if (result?.error) return res.json({ ok: false, error: result.error, message: `TV on failed: ${result.error}` })
  res.json({ ok: true, message: 'TV turning on' })
})

app.post('/api/tv/off', async (req, res) => {
  const result = await tvOff()
  if (result?.error) return res.json({ ok: false, error: result.error, message: `TV off failed: ${result.error}` })
  res.json({ ok: true, message: 'TV turning off' })
})

// Key names the configured TV understands, so the portal can hide the rest
app.get('/api/tv/keys', (req, res) => {
  res.json({ keys: Object.keys(remoteKeys(loadConfig())) })
})

app.post('/api/tv/remote/:key', async (req, res) => {
  const key = req.params.key
  const config = loadConfig()
  if (!Object.hasOwn(remoteKeys(config), key)) return res.status(400).json({ ok: false, message: `Unknown remote key: ${key}` })
  try {
    await sendRemoteKey(config, key)
    lastRemoteKeyAt = Date.now()
    tvScreenOff = false
    logTs(`Remote key: ${key}`)
    // A person opening the TV menu moves its remembered position (see tvOff)
    if (key === 'menu' && config.tvOffMode === 'screen' && config.tvMenuAt !== 'unknown') saveConfig({ ...loadConfig(), tvMenuAt: 'unknown' })
    res.json({ ok: true })
  } catch (e) {
    res.json({ ok: false, message: `Remote failed: ${e.message}` })
  }
})

// The person has left the TV menu where the screen-off key presses expect it.
app.post('/api/tv/menu-synced', (req, res) => {
  saveConfig({ ...loadConfig(), tvMenuAt: 'screen-display' })
  logTs('TV menu marked as back in sync for screen-off')
  res.json({ ok: true, message: 'Screen-off re-synced' })
})

// Setup check for the settings dialog: what the TV at the saved IP answers, and
// which of the wake methods are usable.
app.post('/api/tv/test', async (req, res) => {
  let config = loadConfig()
  if (config.tvType !== 'panasonic') {
    if (!config.tvIp) return res.json({ ok: false, message: 'Enter the TV IP first' })
    const power = await getTvPowerStatus()
    return res.json({
      ok: power !== null,
      message: power === null ? `No answer from ${config.tvIp}. Check the IP and that the TV is on.` : `TV answered: ${power ? 'on' : 'standby'}.`
    })
  }

  const notes = []
  let result = config.tvIp ? await panasonic.probe(config) : { state: 'unreachable' }
  if (result.state === 'unreachable') {
    // No answer at the saved address (or none saved): look for the TV on the LAN
    const found = await panasonic.discover()
    if (found.length === 1) {
      config = { ...loadConfig(), tvIp: found[0], tvMac: '' }
      saveConfig(config)
      logTs(`Found a Viera at ${found[0]}; saved as the TV IP`)
      notes.push(`Found the TV at ${found[0]} and saved that address.`)
      result = await panasonic.probe(config)
    } else if (found.length > 1) {
      notes.push(`Found more than one Viera (${found.join(', ')}). Enter the IP of the one to control.`)
    }
  }
  const mac = result.state === 'unreachable' ? null : learnTvMac(config)
  const cecInstalled = panasonic.cecInstalled()
  if (result.state === 'unreachable') {
    if (!notes.length) notes.push(`${config.tvIp ? `No answer from ${config.tvIp}:55000, and no` : 'No'} Viera found on the kiosk's network. Either the TV is in standby (it drops off the network when off), it has no network connection, or TV Remote is switched off in its network settings.`)
  } else {
    const name = result.model || 'TV'
    notes.push(result.state === 'on'
      ? `${name} answered and is on.`
      : `${name} answered in standby, so it can be switched on over the network. If the screen is on right now, it is not reporting its state and power control will not be reliable.`)
    if (result.encrypted) notes.push('This model needs PIN pairing (2018+ Viera), which is not supported: it will reject key presses.')
    if (mac) notes.push(`MAC ${mac} saved for Wake-on-LAN.`)
  }
  if (config.tvWakeOk === false) notes.push("It could not be switched on from standby last time, so the schedule now leaves it on. If the TV's Network menu has a Powered On by Apps option (under TV Remote App Settings), switch it on, then use TV Off and TV On here to re-test.")
  if (config.tvCec && !cecInstalled) notes.push('HDMI-CEC is switched on but cec-client is not installed on the kiosk.')
  res.json({ ok: result.state !== 'unreachable' && !result.encrypted, ...result, tvIp: config.tvIp, mac: mac || config.tvMac || null, cecInstalled, message: notes.join(' ') })
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

// A DisplayPort output can read "connected, DPMS On" while nothing reaches the TV:
// after the TV power-cycles, nouveau leaves the link to the HDMI adapter untrained
// and still calls it good. The adapter's own lane status (DPCD 0x202-0x204) is the
// truth. true = locked, false = no lock, null = not DisplayPort or unreadable.
function getDpLinkOk(key) {
  try {
    const auxDir = '/sys/class/drm_dp_aux_dev'
    const aux = fs.readdirSync(auxDir).find(a => readSys(`${auxDir}/${a}/name`) === key)
    if (!aux) return null
    const dpcd = (offset, count) => execFileSync('sudo', ['-n', 'dd', `if=/dev/${aux}`, 'bs=1', `skip=${offset}`, `count=${count}`], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const lanes = dpcd(0x101, 1)[0] & 0x1f
    const status = dpcd(0x202, 3)
    if (status.length < 3) return null
    if (!lanes) return false
    for (let i = 0; i < lanes; i++) {
      if (((status[i >> 1] >> ((i & 1) * 4)) & 0x7) !== 0x7) return false
    }
    return (status[2] & 1) === 1
  } catch {
    return null
  }
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
      if (connectors[key].status === 'connected') connectors[key].link = getDpLinkOk(key)
    }
  } catch {}
  return { connectors, fb0Mode: readSys('/sys/class/graphics/fb0/modes') }
}

const KIOSK_VT = 7

// Switch the output off and back on in its current mode: the only thing that makes
// nouveau train the DisplayPort link again (a VT switch does not).
async function retrainDisplayLink(key) {
  if (!/^[\w-]+$/.test(key)) return
  const display = getActiveDisplay()
  const section = runCmd(`DISPLAY=${display} xrandr --current`).split(/^(?=\S)/m).find(s => s.startsWith(`${key} `)) || ''
  const mode = section.match(/^\s+(\d+x\d+)\s.*?(\d+\.\d+)\*/m)
  runCmd(`DISPLAY=${display} xrandr --output ${key} --off`)
  await sleep(3000)
  runCmd(`DISPLAY=${display} xrandr --output ${key} ${mode ? `--mode ${mode[1]} --rate ${mode[2]}` : '--auto'}`)
  await sleep(3000)
}

function unlockedConnector() {
  const { connectors } = getDisplayInfo()
  return Object.keys(connectors).find(k => connectors[k].status === 'connected' && connectors[k].dpms === 'On' && connectors[k].link === false)
}

// Runs from reconcile during scheduled hours. Only while the TV reports on: in
// standby there is nothing to lock to and the output would be cycled all day.
async function healDisplayLink() {
  const key = unlockedConnector()
  if (key) linkSeenDownAt = Date.now()
  if (!key || Date.now() - lastLinkRetrainAt < 60000) return
  if ((await getTvPowerStatus()) !== true) return
  lastLinkRetrainAt = Date.now()
  logTs(`Display: ${key} has no signal lock although the TV is on; cycling the output to retrain it`)
  await retrainDisplayLink(key)
  logTs(`Display: ${key} ${getDisplayInfo().connectors[key]?.link ? 'retrained, signal locked' : 'still has no signal lock'}`)
}

// A power cycle puts the TV menu back at the top, which changes the key presses
// screen-off needs. There is no direct sign of one, so it takes two together: the TV
// off the network and the video link down. Either alone also happens for other
// reasons (a network blip, X restarting), and the after-power-on presses sent from
// the wrong place could change a picture setting.
async function watchTvMenuReset() {
  const cfg = loadConfig()
  if (cfg.tvType !== 'panasonic' || cfg.tvOffMode !== 'screen') return
  if ((await getTvPowerStatus()) !== true) tvSeenOffAt = Date.now()
  if (unlockedConnector()) linkSeenDownAt = Date.now()
  if (!tvSeenOffAt || !linkSeenDownAt || Math.abs(tvSeenOffAt - linkSeenDownAt) > 10 * 60 * 1000) return
  tvSeenOffAt = linkSeenDownAt = 0
  if (loadConfig().tvMenuAt === 'top') return
  saveConfig({ ...loadConfig(), tvMenuAt: 'top' })
  logTs('TV was power-cycled: its menu is back at the top, so the next screen-off uses the after-power-on key presses')
}

async function displayKick() {
  runCmd('sudo chvt 1')
  await new Promise(r => setTimeout(r, 1500))
  runCmd(`sudo chvt ${KIOSK_VT}`)
  const key = unlockedConnector()
  if (key) await retrainDisplayLink(key)
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
  setInterval(() => watchTvMenuReset().catch(e => console.error('TV power watch failed:', e.message)), 20000)
  autologin.startWatcher(loadConfig, logTs)
})