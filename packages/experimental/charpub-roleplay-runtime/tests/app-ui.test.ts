import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { appHTML } from '../src/app-ui.ts'

const template = '<!doctype html><html><body><div id="root"></div><!--CHARPUB_BOOTSTRAP--><script type="module" src="/assets/app.js"></script></body></html>'

void test('the compiled entry receives only inert local bootstrap data', () => {
  const configuration = { nonce: 'local-page-nonce', registryOrigin: 'http://localhost:5173' }
  const document = new JSDOM(appHTML(template, configuration)).window.document
  const data = document.getElementById('charpub-bootstrap')
  assert.equal(data?.getAttribute('type'), 'application/json')
  assert.deepEqual(JSON.parse(data?.textContent ?? ''), configuration)
  assert.equal(document.querySelector('script[type="module"]')?.getAttribute('src'), '/assets/app.js')
  assert.equal(document.querySelectorAll('script').length, 2)
})

void test('bootstrap text cannot close its inert script or inject elements', () => {
  const configuration = { nonce: '</script><img src=x onerror=alert(1)>', registryOrigin: 'http://localhost:5173/?a=<&b=>' }
  const document = new JSDOM(appHTML(template, configuration)).window.document
  assert.equal(document.querySelector('img'), null)
  assert.deepEqual(JSON.parse(document.getElementById('charpub-bootstrap')?.textContent ?? ''), configuration)
})

void test('an absent or duplicated build marker fails instead of serving an unbound page', () => {
  const configuration = { nonce: 'page', registryOrigin: 'http://localhost:5173' }
  assert.throws(() => appHTML('<html></html>', configuration), /assets_invalid/)
  assert.throws(() => appHTML(template + '<!--CHARPUB_BOOTSTRAP-->', configuration), /assets_invalid/)
})
