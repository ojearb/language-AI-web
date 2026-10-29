import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createApp } from '../../server/src/app.js'
import { AppStore } from '../../server/src/store.js'

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url))
const express = requireServer('express')
const clientDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(path.join(tmpdir(), 'language-ai-browser-'))
const store = new AppStore(path.join(directory, 'data.json'))
const requests = []
const pageErrors = []
const sentences = ['This is my book.', 'That bag is Maria’s.', 'The library is on the second floor.', 'I do not read books on Sunday.', 'She also works at the bank.']
const answerText = 'これはマリアさんのかばんです。'
let failTranscription = true
let failReview = true
let browser, apiServer, provider, page

try {
  await store.initialize()
  provider = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const review = body.messages?.[0]?.content.includes('The next message is JSON')
    requests.push({ url: request.url, body, review })
    if ((review && failReview) || (request.url === '/audio/transcriptions' && failTranscription)) {
      const message = review ? 'Review temporarily unavailable.' : 'Transcription temporarily unavailable.'
      if (review) failReview = false
      else failTranscription = false
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message } }))
      return
    }
    const result = request.url === '/audio/transcriptions' ? { text: answerText }
      : { choices: [{ message: { content: review
        ? '### Correct\n\nYour **possession particle** is correct.\n\n- Keep the meaning.\n- Use the target grammar.\n\n| Pattern | Result |\n| --- | --- |\n| Possession | Correct |\n\n<script>window.feedbackInjected = true</script>\n\n![Example](https://example.invalid/tracker.png)'
        : sentences.join('\n') } }] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(result))
  })
  await listen(provider)
  const app = express()
  app.use(express.static(path.join(clientDirectory, 'dist')))
  app.get('/conversations/:id', (_request, response) => response.sendFile(path.join(clientDirectory, 'dist/index.html')))
  app.use(createApp({ store, openRouterConfig: { apiKey: 'test-key', model: 'test/reviewer', baseUrl: `http://127.0.0.1:${provider.address().port}` } }))
  apiServer = createServer(app)
  await listen(apiServer)
  const base = `http://127.0.0.1:${apiServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    window.testStreams = []
    window.testMediaOptions = []
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (options) => { window.testMediaOptions.push(options); const stream = await getUserMedia(options); window.testStreams.push(stream); return stream }
    window.testRevokedUrls = []
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url) => { window.testRevokedUrls.push(url); revoke(url) }
  })
  page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(base)
  await page.getByRole('button', { name: 'Create your first template' }).click()
  await page.getByRole('textbox', { name: /^Name/ }).fill('Everyday Japanese')
  await page.getByRole('textbox', { name: /^Starting prompt/ }).fill('Write 5 simple English sentences for Japanese translation practice. Only output the sentences.')
  await page.getByRole('textbox', { name: /^Answer evaluation prompt/ }).fill('Evaluate the Japanese translation of this English sentence.')
  await page.getByText('Save chat history', { exact: true }).click()
  await page.getByRole('button', { name: 'Create configuration', exact: true }).click()
  await page.getByRole('button', { name: 'Start a new Everyday Japanese chat' }).click()
  const exercise = page.getByRole('region', { name: 'Current exercise', exact: true })
  const choose = (number) => page.getByRole('button', { name: new RegExp(`^Exercise ${number}:`) })
  await choose(5).waitFor()
  assert.equal(await page.getByRole('tab', { name: 'Settings', exact: true }).count(), 0)
  const sessionUrl = page.url()
  assert.equal(await page.getByRole('button', { name: 'Record answer', exact: true }).count(), 0)
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: sentences[1], exact: true }).click()
  await page.getByRole('button', { name: 'Record answer', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: /^Practice/ }).getAttribute('aria-selected'), 'true')
  assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), sentences[1])
  await page.getByRole('button', { name: 'Close voice answer', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Record answer', exact: true }).count(), 0)
  await page.getByRole('group', { name: 'Choose an exercise' }).getByText(sentences[0], { exact: true }).click()
  await page.getByRole('button', { name: 'Record answer', exact: true }).waitFor()
  assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), sentences[0])
  assert.equal(await page.getByRole('group', { name: 'Choose an exercise' }).getByRole('button').count(), 5)
  for (let index = 0; index < sentences.length; index++) {
    await choose(index + 1).click()
    assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), sentences[index])
  }
  await choose(2).click()
  assert.equal(await page.getByRole('textbox', { name: 'Your answer', exact: true }).count(), 0)
  assert.equal(await page.getByRole('region', { name: 'Audio options', exact: true }).count(), 0)
  const screenshots = path.join(clientDirectory, 'test-results')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: path.join(screenshots, 'practice-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('group', { name: 'Choose an exercise' }).getByText(sentences[2], { exact: true }).click()
  assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), sentences[2])
  await choose(2).click()
  await page.screenshot({ path: path.join(screenshots, 'practice-mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const micBounds = await page.getByRole('button', { name: 'Record answer', exact: true }).boundingBox()
  assert.ok(micBounds.y + micBounds.height < 844, 'Microphone is visible without scrolling on mobile')
  await page.setViewportSize({ width: 320, height: 640 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.setViewportSize({ width: 1280, height: 900 })
  console.log('PASS: five unnumbered translation sentences are five selectable exercises; uncluttered desktop and mobile layouts')

  // Cancellation never transcribes; normal stop transcribes and reviews without another click.
  await page.getByRole('button', { name: 'Record answer', exact: true }).click()
  await page.getByRole('button', { name: 'Finish answer', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Record answer', exact: true }).waitFor()
  assert.equal(requests.filter((r) => r.url === '/audio/transcriptions').length, 0)
  await record(page)
  await page.getByRole('alert').filter({ hasText: 'Transcription temporarily unavailable.' }).waitFor()
  await assertReleased(page)
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Review temporarily unavailable.' }).waitFor()
  await page.getByRole('button', { name: 'Retry feedback', exact: true }).click()
  await exercise.getByRole('heading', { name: 'Feedback', exact: true }).waitFor()
  assert.equal(await exercise.locator('.markdown-feedback strong').textContent(), 'possession particle')
  assert.equal(await exercise.locator('.markdown-feedback li').count(), 2)
  assert.equal(await exercise.locator('.markdown-feedback table').count(), 1)
  assert.equal(await exercise.locator('.markdown-feedback script, .markdown-feedback img').count(), 0)
  assert.equal(await page.evaluate(() => window.feedbackInjected), undefined)
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await page.locator('.message-bubble .markdown-feedback strong').waitFor()
  await page.getByRole('tab', { name: /^Practice/ }).click()
  const reviewed = requests.find((r) => r.review)
  assert.equal(JSON.parse(reviewed.body.messages[1].content).question, sentences[1])
  assert.equal(JSON.parse(reviewed.body.messages[1].content).answer, answerText)
  assert.equal(await page.getByRole('progressbar').getAttribute('value'), '1')
  await exercise.getByText('Your answer', { exact: true }).click()
  await exercise.locator('audio').evaluate(async (audio) => audio.play())
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => audio.currentTime > .2))
  await page.getByRole('button', { name: 'Next exercise', exact: true }).click()
  assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), sentences[2])
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('audio')].every((audio) => audio.paused)), true)
  await record(page)
  await exercise.getByRole('heading', { name: 'Feedback', exact: true }).waitFor()
  assert.equal(JSON.parse(requests.filter((r) => r.review).at(-1).body.messages[1].content).question, sentences[2])
  assert.equal(await page.getByRole('progressbar').getAttribute('value'), '2')
  await page.screenshot({ path: path.join(screenshots, 'practice-feedback.png'), fullPage: true })
  console.log('PASS: record → finish → feedback, isolated selected exercise, automatic review, retry, playback and microphone cleanup')

  await page.getByRole('button', { name: 'Next exercise', exact: true }).click()
  await page.getByRole('button', { name: 'Back to prompt library', exact: true }).click()
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  const options = page.getByRole('tabpanel', { name: 'Settings', exact: true })
  await options.getByRole('button', { name: 'Refresh devices', exact: true }).click()
  await options.getByRole('combobox').locator('option').filter({ hasText: 'Fake' }).first().waitFor({ state: 'attached' })
  assert.ok((await options.getByRole('combobox', { name: 'Recording device', exact: true }).locator('option').allTextContents()).some((text) => text.includes('Fake')))
  await options.getByRole('combobox', { name: 'Recording device', exact: true }).selectOption({ index: 1 })
  const selectedDevice = await options.getByRole('combobox').inputValue()
  await options.getByRole('checkbox').check()
  assert.equal(await page.evaluate(() => localStorage.getItem('threadspace.checkTranscript')), 'true')
  await page.screenshot({ path: path.join(screenshots, 'settings-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: path.join(screenshots, 'settings-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(sessionUrl)
  await choose(4).click()
  assert.equal(await exercise.getByRole('combobox').count(), 0)
  assert.equal(await exercise.getByRole('button', { name: 'Audio options', exact: true }).count(), 0)
  await record(page)
  const answer = page.getByRole('textbox', { name: 'Your answer', exact: true })
  await answer.waitFor()
  assert.equal(await page.evaluate(() => window.testMediaOptions.at(-1).audio.deviceId.exact), selectedDevice)
  assert.equal(await answer.inputValue(), answerText)
  await answer.fill('Typed correction for exercise four.')
  await choose(1).click()
  await page.getByRole('button', { name: 'Type instead', exact: true }).click()
  await answer.fill('Draft for exercise one.')
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
  await page.getByRole('tab', { name: /^Practice \d/ }).click()
  assert.equal(await answer.inputValue(), 'Draft for exercise one.')
  await choose(4).click()
  assert.equal(await answer.inputValue(), 'Typed correction for exercise four.')
  await page.getByRole('button', { name: 'Check answer', exact: true }).click()
  await exercise.getByRole('heading', { name: 'Feedback', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Back to prompt library', exact: true }).click()
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  assert.equal(await options.getByRole('combobox').inputValue(), selectedDevice)
  assert.equal(await options.getByRole('checkbox').isChecked(), true)
  await options.getByRole('checkbox').uncheck()
  await page.goto(sessionUrl)
  await choose(1).click()
  await page.getByRole('button', { name: 'Type instead', exact: true }).click()
  await answer.fill('Draft for exercise one.')
  console.log('PASS: optional transcript checking, typed corrections, separate drafts, conversation switching and shared microphone choice')

  await choose(5).click()
  await exercise.locator('.exercise-kicker').click()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Finish answer', exact: true }).waitFor()
  assert.equal(await choose(1).isDisabled(), true)
  assert.equal(await page.getByRole('tab', { name: 'Conversation', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('tab', { name: 'Settings', exact: true }).count(), 0)
  await page.waitForFunction(() => [...document.querySelectorAll('[role="timer"]')].some((el) => el.textContent === '0:01'))
  await page.clock.install()
  await page.clock.fastForward(301_000)
  await exercise.getByRole('heading', { name: 'Feedback', exact: true }).waitFor()
  await page.clock.resume()
  await assertReleased(page)
  await choose(1).click()
  await page.getByRole('button', { name: 'Check answer', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Session complete.' }).waitFor()
  assert.equal(await page.getByRole('progressbar').getAttribute('value'), '5')
  const conversationUrl = page.url()
  await page.reload()
  await choose(1).click()
  await page.getByRole('status').filter({ hasText: 'Session complete.' }).waitFor()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await page.getByRole('button', { name: 'Record answer', exact: true }).click()
  await page.getByRole('button', { name: 'Finish answer', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Back to prompt library', exact: true }).click()
  await page.getByRole('button', { name: 'Start a new Everyday Japanese chat' }).waitFor()
  await assertReleased(page)
  console.log('PASS: space shortcut, five-minute limit, completion, saved feedback and release on navigation')

  const timeConfig = await store.createConfiguration({ name: 'Telling the time', prompt: 'Write a list with times.', saveChats: false, category: 'Japanese' })
  const times = ['AM 7:15', 'PM 3:40', 'AM 11:08', 'PM 6:22', 'AM 9:56']
  const timeSession = await store.createConversation(timeConfig.id, timeConfig.prompt, times.join('\n'))
  await page.goto(`${base}/conversations/${timeSession.id}`)
  await choose(5).click()
  assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), times[4])
  const pairConfig = await store.createConfiguration({ name: 'Places & time intervals', prompt: 'Write a list with time pairs, with a location before each pair.', saveChats: false, category: 'Japanese' })
  const pairs = ['Library\nAM 9:00\nPM 1:30', 'School\nAM 8:15\nPM 3:00']
  const pairSession = await store.createConversation(pairConfig.id, pairConfig.prompt, pairs.join('\n'))
  await page.goto(`${base}/conversations/${pairSession.id}`)
  await choose(2).click()
  assert.equal(await exercise.getByRole('heading', { level: 1 }).textContent(), pairs[1])
  assert.equal(await page.getByRole('group', { name: 'Choose an exercise' }).getByRole('button').count(), 2)
  await page.goto(base)
  await page.getByRole('searchbox', { name: 'Find a topic' }).fill('time')
  assert.equal(await page.locator('.configuration-card').count(), 2)
  await page.getByRole('searchbox', { name: 'Find a topic' }).fill('nothing matches')
  await page.getByText(/No topics match/).waitFor()
  await page.getByRole('searchbox', { name: 'Find a topic' }).fill('')
  await page.screenshot({ path: path.join(screenshots, 'library-desktop.png'), fullPage: true })
  console.log('PASS: unnumbered clock times and grouped location/time pairs in the UI, plus topic search')

  const deniedContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await deniedContext.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError') } })
  const denied = await deniedContext.newPage()
  denied.on('pageerror', (error) => pageErrors.push(error.message))
  await denied.goto(conversationUrl)
  await denied.getByRole('button', { name: /^Exercise 1:/ }).click()
  await denied.getByRole('button', { name: 'Try again', exact: true }).click()
  await denied.getByRole('button', { name: 'Record answer', exact: true }).click()
  await denied.getByRole('alert').filter({ hasText: 'Microphone access was blocked.' }).waitFor()
  await denied.getByRole('button', { name: 'Type an answer', exact: true }).click()
  await denied.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Typed fallback answer.')
  await denied.getByRole('button', { name: 'Check answer', exact: true }).click()
  await denied.getByRole('heading', { name: 'Feedback', exact: true }).waitFor()
  assert.deepEqual(pageErrors, [])
  console.log('PASS: blocked microphone recovery with typed answer; no browser errors')
} catch (error) {
  console.error('Browser errors:', pageErrors)
  if (page) {
    console.error('Visible page:', await page.locator('body').innerText())
    await mkdir(path.join(clientDirectory, 'test-results'), { recursive: true })
    await page.screenshot({ path: path.join(clientDirectory, 'test-results/voice-failure.png'), fullPage: true })
  }
  throw error
} finally {
  await browser?.close()
  await shutdown(apiServer)
  await shutdown(provider)
  await rm(directory, { recursive: true, force: true })
}

async function record(page) {
  await page.getByRole('button', { name: 'Record answer', exact: true }).click()
  await page.getByRole('button', { name: 'Finish answer', exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('[role="timer"]')].some((el) => el.textContent === '0:02'))
  await page.getByRole('button', { name: 'Finish answer', exact: true }).click()
}
async function assertReleased(page) { assert.equal(await page.evaluate(() => window.testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), true) }
function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)) }
async function shutdown(server) { if (!server) return; server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
