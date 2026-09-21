import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const executable = [
  process.env.CHROMIUM_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find((path) => path && existsSync(path))
if (!executable) throw new Error('Set CHROMIUM_PATH to an installed Chromium browser.')

const temporaryRoot = resolve(tmpdir())
const profile = await mkdtemp(join(temporaryRoot, 'messenger-v6-browser-'))
let reportResult
const result = new Promise((done) => { reportResult = done })
const server = await createServer({
  root: fileURLToPath(new URL('../web', import.meta.url)),
  configFile: false,
  server: { host: '127.0.0.1', port: 5186, strictPort: true },
  plugins: [{
    name: 'v6-browser-verification',
    configureServer(vite) {
      vite.middlewares.use('/__verification', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return }
        let body = ''
        request.on('data', (chunk) => { body += chunk })
        request.on('end', () => {
          response.writeHead(204).end()
          try { reportResult(JSON.parse(body)) }
          catch { reportResult({ status: 'failed', text: 'Invalid browser report.' }) }
        })
      })
    },
  }],
})
let browser
let timer
try {
  timer = setTimeout(() => reportResult({ status: 'failed', text: 'Browser verification timed out.' }), 45000)
  await server.listen()
  browser = spawn(executable, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    'http://127.0.0.1:5186/tests/browser-v6.html',
  ], { windowsHide: true, stdio: 'ignore' })
  browser.once('error', (error) => reportResult({ status: 'failed', text: error.message }))
  const report = await result
  if (report.status !== 'passed') throw new Error(report.text)
  console.log(report.text)
} finally {
  clearTimeout(timer)
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise((done) => browser.once('exit', done))
    browser.kill()
    await exited
  }
  await server.close()
  // Only remove the isolated profile created by this invocation.
  if (resolve(profile).startsWith(join(temporaryRoot, 'messenger-v6-browser-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
