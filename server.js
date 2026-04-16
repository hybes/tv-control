const express = require('express')
const { execSync, exec } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')
const cron = require('node-cron')

const app = express()
const PORT = 8080
const CONFIG_PATH = path.join(__dirname, 'config.json')

const defaultConfig = {
  url: 'https://google.com',
  scheduleEnabled: true,
  tvOnTime: '08:45',
  tvOffTime: '17:00',
  scheduleDays: [0, 1, 2, 3],
  dateOverrides: {},
  tvIp: '192.168.1.135',
  tvPsk: 'teleflow'
}

function migrateConfig(config) {
  if (config.weekendsEnabled !== undefined && !config.scheduleDays) {
    config.scheduleDays = config.weekendsEnabled ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3]
    delete config.weekendsEnabled
  }
  if (!config.scheduleDays) config.scheduleDays = [0, 1, 2, 3]
  if (!config.dateOverrides) config.dateOverrides = {}
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

function sonyApi(config, method, params = [], apiPath = '/sony/system') {
  return new Promise((resolve, reject) => {    const postData = JSON.stringify({ method, id: 1, params, version: '1.0' })
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
    const cmd = `DISPLAY=${display} chromium --kiosk --no-first-run --disable-translate --disable-infobars --disable-suggestions-service --disable-save-password-bubble --disable-session-crashed-bubble --noerrdialogs --disable-features=TranslateUI --start-fullscreen --window-size=1920,1080 --window-position=0,0 --user-data-dir=/home/hybes/.config/chromium-kiosk "${url}" &`
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
    setTimeout(() => launchChrome(cfg.url), 5000)
  })

  offJob = cron.schedule(`${offTime.minutes} ${offTime.hours} * * *`, async () => {
    const cfg = loadConfig()
    if (!isTodayActive(cfg)) return
    console.log(`[${new Date().toISOString()}] Schedule: TV OFF + Chrome kill`)
    killChrome()
    setTimeout(() => tvOff(), 2000)
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

  keepaliveTimer = setInterval(async () => {
    if (!isTvScheduledOn()) return

    const isOn = await getTvPowerStatus()
    if (isOn === false) {
      console.log(`[${new Date().toISOString()}] Keepalive: TV in standby during scheduled hours, waking up`)
      await tvOn()
    } else if (isOn === true) {
      const config = loadConfig()
      try {
        await sonyApi(config, 'setPowerStatus', [{ status: true }])
      } catch {}
    }
  }, 4 * 60 * 1000)

  console.log('TV keepalive active (every 4 minutes during scheduled hours)')
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
  res.json({ ok: true, config })
})

app.get('/api/status', async (req, res) => {
  const tvPower = await getTvPowerStatus()
  res.json({
    chrome: getChromeStatus(),
    tv: tvPower,
    scheduleActive: loadConfig().scheduleEnabled
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

app.post('/api/tv/on', async (req, res) => {
  await tvOn()
  res.json({ ok: true, message: 'TV turning on' })
})

app.post('/api/tv/off', async (req, res) => {
  await tvOff()
  res.json({ ok: true, message: 'TV turning off' })
})

app.post('/api/launch', async (req, res) => {
  const config = loadConfig()
  await tvOn()
  setTimeout(() => launchChrome(config.url), 5000)
  res.json({ ok: true, message: 'TV on + Chrome launching' })
})

app.post('/api/shutdown', async (req, res) => {
  killChrome()
  setTimeout(() => tvOff(), 2000)
  res.json({ ok: true, message: 'Chrome killed + TV off' })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard manager running on http://0.0.0.0:${PORT}`)
  setupSchedule()
})