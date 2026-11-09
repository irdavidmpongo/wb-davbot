// Panneau web Levanter : sert public/index.html et relaie /api/* vers l'API du bot.
// La clé API reste côté serveur (jamais envoyée au navigateur).
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const configPath = path.join(__dirname, 'config.env')
if (fs.existsSync(configPath)) require('dotenv').config({ path: configPath })

const WEB_PORT = +process.env.WEB_PORT || 8080
const WEB_PASSWORD = (process.env.WEB_PASSWORD || '').trim()
const API_KEY = (process.env.API_KEY || '').trim()
const API_URL = process.env.API_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
const PM2_NAME = process.env.PM2_NAME || 'levanter'

if (!WEB_PASSWORD) {
  console.error('WEB_PASSWORD manquant dans config.env : le panneau refuse de démarrer.')
  process.exit(1)
}

const sign = (v) => crypto.createHmac('sha256', WEB_PASSWORD).update(v).digest('hex')
const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
const token = () => sign('levanter-panel')
const isAuthed = (req) => {
  const m = /(?:^|;\s*)panel=([a-f0-9]+)/.exec(req.headers.cookie || '')
  return !!m && safeEq(m[1], token())
}
const readBody = (req) =>
  new Promise((res, rej) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy() })
    req.on('end', () => res(d))
    req.on('error', rej)
  })
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(obj))
}

const upstream = async (p, opts = {}) => {
  const r = await fetch(API_URL + p, {
    ...opts,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: r.status, data }
}

// Ajoute un SESSION_ID dans config.env (liste séparée par des virgules)
const addSession = (id) => {
  let env = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  const re = /^SESSION_ID\s*=\s*"?([^"\n]*)"?\s*$/m
  const m = re.exec(env)
  const list = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  if (list.includes(id)) throw new Error('Cette session existe déjà')
  list.push(id)
  const line = `SESSION_ID="${list.join(',')}"`
  env = m ? env.replace(re, line) : env + (env.endsWith('\n') || !env ? '' : '\n') + line + '\n'
  fs.writeFileSync(configPath, env)
  return list.length
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')))
    }
    if (url.pathname === '/panel/login' && req.method === 'POST') {
      const { password = '' } = JSON.parse((await readBody(req)) || '{}')
      if (!safeEq(sign(String(password).trim()), sign(WEB_PASSWORD))) return json(res, 401, { error: 'Mot de passe incorrect' })
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `panel=${token()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      })
    }
    if (!isAuthed(req)) return json(res, 401, { error: 'Non connecté' })

    if (url.pathname === '/panel/me') return json(res, 200, { ok: true, apiConfigured: !!API_KEY })
    if (url.pathname === '/panel/sessions' && req.method === 'GET') {
      const r = await upstream('/api/sessions')
      return json(res, r.status, r.data)
    }
    if (url.pathname === '/panel/send' && req.method === 'POST') {
      const r = await upstream('/api/send', { method: 'POST', body: (await readBody(req)) || '{}' })
      return json(res, r.status, r.data)
    }
    if (url.pathname === '/panel/add-session' && req.method === 'POST') {
      const { sessionId = '' } = JSON.parse((await readBody(req)) || '{}')
      const id = String(sessionId).trim()
      if (!/^[\w\-:.=+/]{6,}$/.test(id)) return json(res, 400, { error: 'SESSION_ID invalide' })
      const count = addSession(id)
      return json(res, 200, { ok: true, count, note: 'Session ajoutée. Redémarre le bot pour la connecter.' })
    }
    if (url.pathname === '/panel/restart' && req.method === 'POST') {
      return execFile('pm2', ['restart', PM2_NAME], (err) =>
        err ? json(res, 500, { error: 'pm2 restart a échoué : ' + err.message }) : json(res, 200, { ok: true })
      )
    }
    json(res, 404, { error: 'Introuvable' })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
})

server.listen(WEB_PORT, () => console.log(`Panneau Levanter : http://localhost:${WEB_PORT}`))
