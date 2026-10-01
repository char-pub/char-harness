/** The rendered welcome shell directs users to the configured Registry without starting a session. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { appHTML } from '../src/app-ui.ts'
import { replayInput } from '../../charpub-roleplay/tests/fixtures.ts'

const runtimeURL = 'http://127.0.0.1:19389/'
const registryURL = 'http://localhost:5173'

void test('welcome page offers a real Registry link and steps, with manual launch kept advanced', (context) => {
  const dom = new JSDOM(appHTML('test-page-nonce', registryURL), { url: runtimeURL, runScripts: 'dangerously' })
  context.after(() => { dom.window.close() })
  const page = dom.window.document
  const browse = page.querySelector<HTMLAnchorElement>('#registry-link')
  const advanced = page.querySelector<HTMLDetailsElement>('#manual-launch')
  const review = page.querySelector<HTMLButtonElement>('#review')
  const input = page.querySelector<HTMLTextAreaElement>('#launch')
  assert.ok(browse && advanced && review && input)
  assert.equal(dom.window.getComputedStyle(page.documentElement).backgroundColor, 'rgb(248, 250, 252)')
  assert.equal(dom.window.getComputedStyle(page.body).color, 'rgb(23, 32, 51)')
  assert.equal(dom.window.getComputedStyle(input).backgroundColor, 'rgb(255, 255, 255)')
  assert.equal(dom.window.getComputedStyle(input).color, 'rgb(23, 32, 51)')
  context.assert.snapshot({
    heading: page.querySelector('#welcome h2')?.textContent,
    browse: { text: browse.textContent, href: browse.href, target: browse.target, rel: browse.rel },
    steps: [...page.querySelectorAll('#welcome li')].map(item => item.textContent),
    status: page.querySelector('#status')?.textContent,
    advanced: { label: advanced.querySelector('summary')?.textContent, open: advanced.open },
    reviewDisabled: review.disabled,
    gameHidden: page.querySelector<HTMLElement>('#game')?.hidden,
  })
  advanced.querySelector('summary')?.click()
  assert.equal(advanced.open, true)
  input.value = '{}'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(review.disabled, false)
  assert.match(page.querySelector('#status')?.textContent ?? '', /Review the exact version/)
  assert.equal(page.querySelector<HTMLElement>('#candidate')?.hidden, true)
  input.value = ''; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(review.disabled, true)
  assert.equal(page.querySelector<HTMLElement>('#welcome')?.hidden, false)
})

for (const incoming of ['fragment', 'authorization-return'] as const) {
  void test(`an incoming ${incoming} launch preserves review without returning to the empty welcome state`, async (context) => {
    const fixture = replayInput('narrator')
    const launch = { format: 'char.pub/runtime-launch', version: 1, registry_origin: registryURL, source: fixture.artifact.root, lock_digest: fixture.artifact.lock_digest, locale: 'en', view: { mode: 'narrator' } }
    const encoded = JSON.stringify(launch)
    const requests: { path: string; body: unknown; nonce: string | null }[] = []
    const dom = new JSDOM(appHTML('test-page-nonce', registryURL), {
      url: incoming === 'fragment' ? `${runtimeURL}#launch=${encodeURIComponent(encoded)}` : runtimeURL,
      runScripts: 'dangerously',
      beforeParse(window) {
        if (incoming === 'authorization-return') window.sessionStorage.setItem('roleplay-launch', encoded)
        window.fetch = async (input, init) => {
          assert.ok(typeof input === 'string' && init && typeof init.body === 'string')
          requests.push({ path: input, body: JSON.parse(init.body), nonce: new Headers(init.headers).get('X-Roleplay-Client') })
          return new Response(JSON.stringify({ review: 'review-ticket', source: launch.source, metadata: { rating: 'general' }, capabilities: [], support: {}, restart_required: false, starts: [], view: { mode: 'narrator' }, late_slots: [], participants: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
      },
    })
    context.after(() => { dom.window.close() })
    const page = dom.window.document
    const review = page.querySelector<HTMLButtonElement>('#review')
    assert.ok(review)
    assert.equal(requests.length, 0)
    assert.equal(dom.window.location.hash, '')
    assert.equal(dom.window.sessionStorage.getItem('roleplay-launch'), encoded)
    assert.equal(page.querySelector<HTMLTextAreaElement>('#launch')?.value, encoded)
    assert.equal(page.querySelector<HTMLElement>('#welcome')?.hidden, true)
    assert.equal(page.querySelector<HTMLElement>('#launch-ready')?.hidden, false)
    assert.equal(page.querySelector<HTMLDetailsElement>('#manual-launch')?.open, false)
    assert.equal(review.disabled, false)
    assert.equal([...page.querySelectorAll('p')].filter(item => item.textContent?.includes('Launch details received.')).length, 1)
    review.click()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(requests, [{ path: '/api/review', body: launch, nonce: 'test-page-nonce' }])
    assert.equal(page.querySelector<HTMLElement>('#candidate')?.hidden, false)
    assert.equal(page.querySelector<HTMLElement>('#game')?.hidden, true)
    assert.equal(page.querySelector<HTMLInputElement>('#accept')?.checked, false)
    const field = page.querySelector<HTMLTextAreaElement>('#launch'); assert.ok(field)
    field.value = ''; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    assert.equal(page.querySelector<HTMLElement>('#candidate')?.hidden, true)
    assert.equal(review.disabled, true)
    assert.equal(requests.length, 1)
  })
}
