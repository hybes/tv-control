const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const WebSocket = require('ws')

const CDP_BASE = 'http://127.0.0.1:9222'

function cdpTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${CDP_BASE}/json`, { timeout: 4000 }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('cdp timeout')) })
  })
}

async function kioskTarget() {
  const targets = await cdpTargets()
  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
  return pages.find(t => /teleflow/i.test(t.url || '')) || pages[0] || null
}

function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    let nextId = 0
    const pending = new Map()
    const timer = setTimeout(() => { reject(new Error('cdp ws connect timeout')); try { ws.close() } catch {} }, 6000)
    ws.on('message', m => {
      let msg
      try { msg = JSON.parse(m) } catch { return }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    })
    ws.on('error', e => { clearTimeout(timer); reject(e) })
    ws.on('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId
            const to = setTimeout(() => { pending.delete(id); rej(new Error(`cdp ${method} timeout`)) }, 15000)
            pending.set(id, msg => { clearTimeout(to); res(msg) })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        close() { try { ws.close() } catch {} }
      })
    })
  })
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.result && 'value' in r.result.result) return r.result.result.value
  return null
}

const wait = ms => new Promise(r => setTimeout(r, ms))

function decryptChromeLogin(profileDir, originLike) {
  const src = path.join(profileDir, 'Default', 'Login Data')
  if (!fs.existsSync(src)) return { error: 'no-login-data' }
  const tmp = path.join(os.tmpdir(), `tvld-${process.pid}-${Date.now()}.db`)
  fs.copyFileSync(src, tmp)
  try {
    const safe = String(originLike).replace(/'/g, "''")
    const sql = `SELECT username_value || char(31) || quote(password_value) FROM logins WHERE origin_url LIKE '%${safe}%' AND length(password_value) > 0 ORDER BY id DESC LIMIT 1;`
    const out = execFileSync('sqlite3', [tmp, sql], { timeout: 8000 }).toString().trim()
    if (!out) return { error: 'no-credential-row' }
    const sep = out.indexOf('\x1f')
    const username = out.slice(0, sep)
    const blobLiteral = out.slice(sep + 1).trim()
    const hex = blobLiteral.replace(/^X'/, '').replace(/'$/, '')
    const enc = Buffer.from(hex, 'hex')
    if (enc.length <= 3) return { error: 'empty-password' }
    const prefix = enc.slice(0, 3).toString('ascii')
    if (prefix === 'v11') return { error: 'keyring-encrypted' }
    const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    const iv = Buffer.alloc(16, 0x20)
    const dec = crypto.createDecipheriv('aes-128-cbc', key, iv)
    const password = Buffer.concat([dec.update(enc.slice(3)), dec.final()]).toString('utf8')
    return { username, password }
  } catch (e) {
    return { error: e.message }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

const STATE_JS = `(()=>{const vis=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};const pw=[...document.querySelectorAll('input[type=password]')].some(vis);const user=[...document.querySelectorAll('input#username,input[name=username],input[type=email],input[autocomplete*=username]')].some(vis);return JSON.stringify({host:location.host,href:location.href,ready:document.readyState,hasPw:pw,hasUser:user});})()`

function fillJs(selector, value) {
  return `(()=>{const vis=el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(vis);if(!el)return 'no-el';el.focus();const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()`
}

const SUBMIT_JS = `(()=>{const b=document.querySelector('button[data-action-button-primary="true"][type=submit]')||document.querySelector('button[type=submit][name=action][value=default]')||document.querySelector('button[type=submit]');if(!b)return 'no-btn';b.click();return 'clicked';})()`

const SKIP_JS = `(()=>{const vis=el=>{if(!el)return false;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};const cb=[...document.querySelectorAll('input[type=checkbox]')].filter(vis).find(c=>/dontshow|don.?t.?show|remind/i.test((c.name||'')+(c.id||'')));if(cb&&!cb.checked)cb.click();const btns=[...document.querySelectorAll('button[name=action],button[type=submit]')].filter(vis);const skipVals=['abort-passkey-enrollment','skip','refuse-add-passkey','deny','cancel'];let b=btns.find(x=>skipVals.includes(x.value));if(!b)b=btns.find(x=>x.value!=='default'&&/continue without|maybe later|not now|no thanks|skip|remind me later/i.test(x.innerText||''));if(!b)return 'no-skip';b.click();return 'skipped:'+(b.value||(b.innerText||'').trim());})()`

function optsFromConfig(config) {
  return {
    profileDir: config.chromeProfile || '/home/hybes/.config/chromium-kiosk',
    credentialOrigin: config.loginCredentialOrigin || config.loginHost || 'login.teleflow.app',
    loginHost: config.loginHost || 'login.teleflow.app',
    dashboardHost: hostOf(config.url) || 'im.teleflow.app',
    username: config.loginUsername || '',
    password: config.loginPassword || ''
  }
}

async function performLogin(config, log = () => {}) {
  const o = optsFromConfig(config)
  let cred = (o.username && o.password) ? { username: o.username, password: o.password } : decryptChromeLogin(o.profileDir, o.credentialOrigin)
  if (!cred || cred.error || !cred.password) return { ok: false, reason: 'credential:' + ((cred && cred.error) || 'missing') }

  const target = await kioskTarget()
  if (!target) return { ok: false, reason: 'no-cdp-target' }
  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  let userSubmitted = false
  let pwSubmitted = false
  let skipCount = 0
  try {
    for (let i = 0; i < 16; i++) {
      const raw = await evaluate(cdp, STATE_JS)
      const st = raw ? JSON.parse(raw) : null
      if (!st) { await wait(1000); continue }
      if (st.host && st.host.includes(o.dashboardHost) && !st.host.includes(o.loginHost)) {
        return { ok: true, username: cred.username }
      }
      if (st.ready !== 'complete') { await wait(800); continue }
      if (st.hasPw) {
        if (pwSubmitted) return { ok: false, reason: 'password-not-accepted', host: st.host }
        await evaluate(cdp, fillJs('input[type=password]', cred.password))
        await wait(200)
        await evaluate(cdp, SUBMIT_JS)
        pwSubmitted = true
        await wait(3000)
      } else if (st.hasUser) {
        if (userSubmitted) return { ok: false, reason: 'identifier-not-accepted', host: st.host }
        await evaluate(cdp, fillJs('input#username,input[name=username],input[type=email]', cred.username))
        await wait(200)
        await evaluate(cdp, SUBMIT_JS)
        userSubmitted = true
        await wait(3000)
      } else {
        if (skipCount >= 3) return { ok: false, reason: 'interstitial-stuck', host: st.host }
        const skipped = await evaluate(cdp, SKIP_JS)
        if (skipped === 'no-skip') return { ok: false, reason: 'interstitial-no-skip', host: st.host }
        skipCount++
        await wait(3000)
      }
    }
    const host = hostOf((JSON.parse(await evaluate(cdp, STATE_JS) || '{}')).href || '')
    if (host.includes(o.dashboardHost) && !host.includes(o.loginHost)) return { ok: true, username: cred.username }
    return { ok: false, reason: 'gave-up', host }
  } finally {
    cdp.close()
  }
}

let watcherTimer = null
let busy = false
let backoffUntil = 0
let lastResult = null
let lastCheck = 0

async function checkOnce(config, log) {
  if (busy || Date.now() < backoffUntil) return
  lastCheck = Date.now()
  const loginHost = config.loginHost || 'login.teleflow.app'
  let target
  try { target = await kioskTarget() } catch { return }
  if (!target) return
  const host = hostOf(target.url)
  if (!host || !host.includes(loginHost)) return

  busy = true
  log(`Auto-relogin: login page detected (${host}), attempting...`)
  try {
    const res = await performLogin(config, log)
    lastResult = { ...res, at: new Date().toISOString() }
    if (res.ok) {
      log(`Auto-relogin: signed in as ${res.username}`)
    } else {
      backoffUntil = Date.now() + 5 * 60 * 1000
      log(`Auto-relogin: failed (${res.reason}${res.host ? ', ' + res.host : ''}); backing off 5m`)
    }
  } catch (e) {
    lastResult = { ok: false, reason: 'error:' + e.message, at: new Date().toISOString() }
    backoffUntil = Date.now() + 2 * 60 * 1000
    log(`Auto-relogin error: ${e.message}; backing off 2m`)
  } finally {
    busy = false
  }
}

function startWatcher(getConfig, log = console.log) {
  stopWatcher()
  const cfg = getConfig()
  const sec = Math.max(10, cfg.autoLoginCheckSec || 30)
  watcherTimer = setInterval(() => {
    const c = getConfig()
    if (c.autoLoginEnabled === false) return
    checkOnce(c, log).catch(e => log('Auto-relogin loop error: ' + e.message))
  }, sec * 1000)
  log(`Auto-relogin watcher active (every ${sec}s; login host ${cfg.loginHost || 'login.teleflow.app'})`)
}

function stopWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null }
}

async function reloginNow(getConfig, log = console.log) {
  if (busy) return { ok: false, reason: 'already-running' }
  busy = true
  try {
    const res = await performLogin(getConfig(), log)
    lastResult = { ...res, at: new Date().toISOString() }
    if (res.ok) backoffUntil = 0
    return res
  } catch (e) {
    lastResult = { ok: false, reason: 'error:' + e.message, at: new Date().toISOString() }
    return lastResult
  } finally {
    busy = false
  }
}

function getStatus() {
  return { busy, backoffUntil, lastCheck, lastResult }
}

module.exports = { startWatcher, stopWatcher, reloginNow, performLogin, getStatus, decryptChromeLogin }
