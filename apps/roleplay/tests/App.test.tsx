/** Browser interactions use authoritative DTO fixtures; these tests do not claim model quality or online connectivity. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AppLaunchReview,
  AppSessionSnapshot,
  AppStatus,
  AppTurnResult,
  AppTurnRequest,
  AppModelProvider,
  AppModelsView,
  AppPluginConfigView,
  AppPluginsView,
} from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { App } from '../src/App.tsx'
import { RoleplayApiError, type RoleplayApi } from '../src/api.ts'

const bootstrap = { nonce: 'local-page-nonce', registryOrigin: 'https://registry.example' }
const source = {
  ref: 'story.test/lantern@1.0.0',
  release: 'rel_01j00000000000000000000000',
  semantic_digest: `sha256:${'a'.repeat(64)}`,
}
const work = {
  title: 'The Lantern House',
  source,
  source_label: '1.0.0',
  locale: 'en',
  summary: 'A light burns beside the empty harbor.',
}
function snapshot(record = 'first', patch: Partial<AppSessionSnapshot> = {}): AppSessionSnapshot {
  return {
    session: `handle-${record}`,
    record,
    work: { ...work, title: record === 'second' ? 'The Other Shore' : work.title },
    history: [{ role: 'assistant', speaker: 'innkeeper', text: 'The innkeeper leaves a light in the window.' }],
    participants: [{ key: 'innkeeper', name: 'Mira', present: true }],
    late_slots: [],
    scene: { id: 'harbor', title: 'Harbor at dusk', description: 'Rain falls on the quiet pier.' },
    stopped: false,
    interrupted: false,
    can_continue: true,
    limitations: [],
    ...patch,
  }
}
const status: AppStatus = {
  registry: { origin: bootstrap.registryOrigin, authorization: 'authorized' },
  model: {
    provider: 'deepseek-official',
    id: 'configured-model',
    credential: { configured: true, source: 'file', writable: true },
    online_verified: false,
  },
  operation: null,
  limitations: [],
}
const deepseekSchema = {
  uid: 4,
  refs: {
    1: { type: 'string', meta: { volatile: true } },
    2: { type: 'object', meta: {}, dict: { id: 3, name: 1 } },
    3: { type: 'string', meta: { required: true } },
    4: { type: 'object', meta: { default: {} }, dict: { baseURL: 1, models: 5, apiKeyEnv: 1 } },
    5: { type: 'array', meta: { volatile: true, default: [{ id: 'deepseek-flash', name: 'Flash' }] }, inner: 2 },
  },
}
function providers(credential: AppModelProvider['credential'] = { configured: false, writable: true }, patch: Partial<AppModelProvider> = {}): AppModelsView {
  return {
    providers: [{
      provider: 'deepseek-official', display_name: 'DeepSeek', ns: 'roleplay-model', path: [], credential_ref: 'DEEPSEEK_API_KEY',
      credential, settings_writable: true,
      form: {
        schema: deepseekSchema,
        value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
        base: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
        user: {}, revision: 3, writable: true,
      },
      ...patch,
    }],
  }
}
const pluginsView: AppPluginsView = {
  entries: [
    { entry_id: 'include:roleplay-runtime', ns: 'roleplay-runtime', module_name: '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime', enabled: true, phase: 'active', configurable: 'none', settings_writable: true, meta: { title: { en: 'char.pub roleplay', zh: 'char.pub 角色扮演' }, description: { en: 'Play stories.', zh: '游玩故事。' } } },
    { entry_id: 'include:roleplay-model', ns: 'roleplay-model', module_name: '@deepseek-ai/dsh-llm-deepseek-api-key', enabled: true, phase: 'active', configurable: 'models', settings_writable: true },
    { entry_id: 'include:pace', ns: 'pace', module_name: '@example/pace', enabled: true, phase: 'active', configurable: 'form', settings_writable: true, meta: { title: 'Pacing', description: 'Scene pacing limits.' } },
    { entry_id: 'include:broken', ns: 'broken', module_name: '@example/broken', enabled: true, phase: 'failed', configurable: 'none', settings_writable: true },
  ],
}
const paceForm: AppPluginConfigView = {
  ns: 'pace',
  schema: { uid: 3, refs: { 1: { type: 'number', meta: { min: 1, default: 3, description: 'Scenes per chapter', volatile: true } }, 2: { type: 'boolean', meta: { default: true, volatile: true } }, 3: { type: 'object', meta: { default: {} }, dict: { scenes: 1, recap: 2 } } } },
  value: { scenes: 3, recap: true }, base: { scenes: 3, recap: true }, user: {}, revision: 1, writable: true,
}
function review(): AppLaunchReview {
  return {
    review: 'review-exact-version',
    source,
    work,
    title: work.title,
    metadata: {
      default_locale: 'en',
      available_locales: ['en'],
      rating: 'general',
      rating_sources: [],
      content_warnings: [],
      licenses: [],
      attribution: [],
      contributors: [],
      import_omissions: [],
      au: false,
      recommended_presets: [],
    },
    capabilities: [],
    support: { status: 'supported', missing: [], degraded: [] },
    starts: [{ id: 'arrival', title: 'An unexpected arrival', description: 'Come ashore after dark.' }],
    participants: [],
    late_slots: [],
    locale: 'en',
    view: { mode: 'narrator' },
    restart_required: false,
  }
}
type TestApi = { [K in keyof RoleplayApi]: (...args: Parameters<RoleplayApi[K]>) => ReturnType<RoleplayApi[K]> }
function makeApi(overrides: Partial<RoleplayApi> = {}): TestApi {
  return {
    status: vi.fn(async () => status),
    sessions: vi.fn(async () => ({ items: [] })),
    session: vi.fn(async () => snapshot()),
    review: vi.fn(async () => review()),
    start: vi.fn(async () => snapshot()),
    resume: vi.fn(async (record: string) => snapshot(record)),
    turn: vi.fn(async (input: AppTurnRequest) => ({
      request_id: input.request_id,
      status: 'success' as const,
      snapshot: snapshot(),
    })),
    turnStatus: vi.fn(async (_session: string, request_id: string) => ({
      request_id,
      status: 'not_found' as const,
      snapshot: snapshot(),
    })),
    cancel: vi.fn(async () => {}),
    authorize: vi.fn(async () => ({ authorizationURL: 'https://registry.example/authorize' })),
    models: vi.fn(async () => providers({ configured: true, source: 'file', writable: true })),
    saveModel: vi.fn(async () => providers({ configured: true, source: 'file', writable: true })),
    clearModelKey: vi.fn(async () => providers()),
    plugins: vi.fn(async () => pluginsView),
    pluginConfig: vi.fn(async () => paceForm),
    savePluginConfig: vi.fn(async () => ({ ...paceForm, value: { scenes: 5, recap: true }, user: { scenes: 5 }, revision: 2 })),
    prepareExport: vi.fn(async () => ({ digest: 'review-digest', payload: { synthetic: true } })),
    exportPreview: vi.fn(async () => ({ json: '{"synthetic":true}', payload: { synthetic: true } })),
    ...overrides,
  }
}
/** jsdom does not toggle <details> from a summary click; open the disclosure the way a browser would. */
function openDetails(summary: HTMLElement) {
  const details = summary.closest('details')
  if (!details) throw new Error('summary outside details')
  details.open = true
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
function mount(api: RoleplayApi) {
  return render(<App api={api} bootstrap={bootstrap} />)
}
async function active(api = makeApi({ status: vi.fn(async () => ({ ...status, current_session: 'handle-first' })) })) {
  mount(api)
  await screen.findByRole('textbox', { name: 'Your next move' })
  return api
}
function reply(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Your next move' }), { target: { value: text } })
}
function send() {
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
  }
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  sessionStorage.clear()
  localStorage.clear()
  localStorage.setItem('charpub-roleplay-language', 'en')
  history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('story discovery and exact-version setup', () => {
  it('offers a real configured Registry entry, keeps manual launch advanced, and never claims online model verification', async () => {
    const api = makeApi()
    mount(api)
    expect(await screen.findByRole('link', { name: 'Explore stories on char.pub' })).toHaveProperty(
      'href',
      bootstrap.registryOrigin + '/',
    )
    expect(screen.getByRole('button', { name: 'Review this version' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Advanced: launch details').closest('details')?.open).toBe(false)
    expect(await screen.findByText('Your first story is waiting')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Models' }))
    expect(await within(dialog).findByText('DeepSeek')).toBeTruthy()
    expect(within(dialog).getByRole('img', { name: 'API key configured' })).toBeTruthy()
    expect(api.review).not.toHaveBeenCalled()
    expect(api.turn).not.toHaveBeenCalled()
  })
  it('restores the exact hash intent across the OAuth return and invalidates review when manual bytes change', async () => {
    const launch = '{ "source": { "release": "exact" }, "locale":"ja" }'
    history.replaceState(null, '', `/#launch=${encodeURIComponent(launch)}`)
    const api = makeApi()
    const mounted = mount(api)
    await screen.findByText('An unexpected arrival')
    expect(api.review).toHaveBeenCalledWith(JSON.parse(launch))
    expect(location.hash).toBe('')
    expect(sessionStorage.getItem('roleplay-launch')).toBe(launch)
    mounted.unmount()
    mount(api)
    await screen.findByText('An unexpected arrival')
    expect(api.review).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Enter the story' })).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Launch JSON' }), { target: { value: '' } })
    expect(screen.queryByRole('button', { name: 'Enter the story' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Review this version' })).toHaveProperty('disabled', true)
    expect(sessionStorage.getItem('roleplay-launch')).toBeNull()
    expect(api.start).not.toHaveBeenCalled()
  })
  it('requires the reviewed version and fresh required role before starting; source changes never reuse the old review', async () => {
    const setup = {
      ...review(),
      late_slots: [
        { key: 'traveler', accepts: ['persona' as const], required: true, used_by: ['player'], hint: 'Your traveler' },
      ],
    }
    sessionStorage.setItem('roleplay-launch', '{"source":"first"}')
    const api = makeApi({ review: vi.fn(async () => setup) })
    mount(api)
    await screen.findByText('An unexpected arrival')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Enter the story' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Character name' }), { target: { value: 'Jun' } })
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enter the story' }))
    await screen.findByRole('textbox', { name: 'Your next move' })
    expect(api.start).toHaveBeenCalledWith({
      review: setup.review,
      bindings: { traveler: { kind: 'persona', display_name: 'Jun' } },
      start: 'arrival',
      restart: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'New story' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Launch JSON' }), { target: { value: '{"source":"second"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review this version' }))
    await screen.findByText('An unexpected arrival')
    expect(screen.getByRole('textbox', { name: 'Character name' })).toHaveProperty('value', '')
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
  })
})

describe('real conversation lifecycle', () => {
  it('restores the current handle on reload without creating a session and keeps later composer edits after a reply settles', async () => {
    const operation = deferred<AppTurnResult>()
    const api = await active(
      makeApi({
        status: vi.fn(async () => ({ ...status, current_session: 'handle-first' })),
        turn: vi.fn(() => operation.promise),
      }),
    )
    expect(api.session).toHaveBeenCalledWith('handle-first')
    expect(api.start).not.toHaveBeenCalled()
    expect(within(screen.getByRole('region', { name: work.title })).getByText('Mira')).toBeTruthy()
    reply('I knock.')
    send()
    expect(screen.getByText('Writing the next moment…')).toBeTruthy()
    reply('A thought for later')
    const input = vi.mocked(api.turn).mock.calls[0][0]
    await act(async () => {
      operation.resolve({
        request_id: input.request_id,
        status: 'success' as const,
        snapshot: snapshot('first', {
          history: [
            { role: 'user', text: input.text },
            { role: 'assistant', speaker: 'innkeeper', text: 'Come in.' },
          ],
        }),
      })
    })
    expect(await screen.findByText('Come in.')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Your next move' })).toHaveProperty('value', 'A thought for later')
    expect(api.turn).toHaveBeenCalledTimes(1)
  })
  it('preserves separate drafts when selecting actual local records and never reuses the previous session handle', async () => {
    const api = makeApi({
      sessions: vi.fn(async () => ({
        items: ['first', 'second'].map(record => ({
          record,
          created_at: '2026-10-01T00:00:00Z',
          work: snapshot(record).work,
          state: 'ready' as const,
        })),
      })),
    })
    mount(api)
    fireEvent.click(await screen.findByRole('button', { name: /The Lantern House/ }))
    await screen.findByRole('textbox', { name: 'Your next move' })
    reply('Draft one')
    fireEvent.click(screen.getByRole('button', { name: /The Other Shore/ }))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Your next move' })).toHaveProperty('value', '')
    })
    reply('Draft two')
    fireEvent.click(screen.getByRole('button', { name: /The Lantern House/ }))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Your next move' })).toHaveProperty('value', 'Draft one')
    })
    send()
    await waitFor(() => {
      expect(api.turn).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(api.turn).mock.calls[0][0].session).toBe('handle-first')
    expect(sessionStorage.getItem('charpub-roleplay-reply-drafts')).toContain('Draft two')
  })
  it('checks an unknown result and resends only the same ID and original text after an explicit not-found result', async () => {
    const turn = vi
      .fn<RoleplayApi['turn']>()
      .mockRejectedValueOnce(new RoleplayApiError('roleplay_app.connection_lost', true))
      .mockImplementationOnce(async (input: AppTurnRequest) => ({
        request_id: input.request_id,
        status: 'success' as const,
        snapshot: snapshot(),
      }))
    const api = await active(
      makeApi({ status: vi.fn(async () => ({ ...status, current_session: 'handle-first' })), turn }),
    )
    reply('The original message')
    send()
    await screen.findByText('The reply result is not confirmed')
    reply('New unsent draft')
    send()
    expect(turn).toHaveBeenCalledTimes(1)
    const original = turn.mock.calls[0][0]
    fireEvent.click(screen.getByRole('button', { name: 'Check request status' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Resend the same request' }))
    await waitFor(() => {
      expect(turn).toHaveBeenCalledTimes(2)
    })
    expect(turn.mock.calls[1][0]).toEqual(original)
    expect(api.turnStatus).toHaveBeenCalledWith('handle-first', original.request_id)
    expect(screen.getByRole('textbox', { name: 'Your next move' })).toHaveProperty('value', 'New unsent draft')
  })
  it('addresses cancellation to the active request, keeps the text, and displays only the final saved result', async () => {
    const operation = deferred<AppTurnResult>()
    const api = await active(
      makeApi({
        status: vi.fn(async () => ({ ...status, current_session: 'handle-first' })),
        turn: vi.fn(() => operation.promise),
      }),
    )
    reply('Wait by the door')
    send()
    const input = vi.mocked(api.turn).mock.calls[0][0]
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => {
      expect(api.cancel).toHaveBeenCalledWith({ session: input.session, request_id: input.request_id })
    })
    await act(async () => {
      operation.resolve({ request_id: input.request_id, status: 'cancelled', snapshot: snapshot() })
    })
    expect(screen.getByRole('textbox', { name: 'Your next move' })).toHaveProperty('value', input.text)
    expect(screen.queryByText('Writing the next moment…')).toBeNull()
  })
  it('reconciles a persisted unfinished request before explicitly sending a new recovery request', async () => {
    const interrupted = snapshot('first', { interrupted: true, can_continue: false })
    sessionStorage.setItem(
      'charpub-roleplay-pending-requests',
      JSON.stringify({
        first: {
          request: { session: 'expired-handle', request_id: 'old-request', text: 'Previous message' },
          phase: 'sending',
        },
      }),
    )
    sessionStorage.setItem('charpub-roleplay-reply-drafts', JSON.stringify({ first: 'New direction' }))
    const api = await active(
      makeApi({
        status: vi.fn(async () => ({ ...status, current_session: interrupted.session })),
        session: vi.fn(async () => interrupted),
        turnStatus: vi.fn(async () => ({
          request_id: 'old-request',
          status: 'failed' as const,
          error_code: 'interrupted',
          snapshot: interrupted,
        })),
      }),
    )
    expect(
      screen.getByRole('checkbox', { name: 'End the unfinished request and continue with a new message.' }),
    ).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Check request status' }))
    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toHaveProperty('disabled', false)
    })
    expect(api.turn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    send()
    await waitFor(() => {
      expect(api.turn).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(api.turn).mock.calls[0][0]).toMatchObject({
      session: interrupted.session,
      text: 'New direction',
      recover_interrupted: true,
    })
    expect(vi.mocked(api.turn).mock.calls[0][0].request_id).not.toBe('old-request')
  })
})

describe('local controls and synthetic preview', () => {
  it('changes interface language and theme without changing authored text or sending model calls', async () => {
    const api = await active()
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.change(screen.getByRole('combobox', { name: /Interface language/ }), { target: { value: 'zh' } })
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '外观' })).getByRole('radio', { name: '深色' }))
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '增大字号' }))
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('15px')
    expect(localStorage.getItem('charpub-roleplay-font-size')).toBe('15')
    expect(screen.getByText('The innkeeper leaves a light in the window.')).toBeTruthy()
    expect(api.turn).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('opens the first provider as a setup card and saves its key and endpoint through one Models write', async () => {
    const api = makeApi({
      status: vi.fn(async () => ({ ...status, model: { ...status.model, credential: { configured: false, writable: true } } })),
      models: vi.fn(async () => providers()),
    })
    mount(api)
    expect(await screen.findByText('Add a model API key in Settings before replying.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    const key = await within(dialog).findByLabelText('API key')
    fireEvent.change(key, { target: { value: 'KEY="quoted"' } })
    expect(within(dialog).getByText('This API key is malformed. Check it and try again.')).toBeTruthy()
    fireEvent.change(key, { target: { value: '  sk-entered  ' } })
    openDetails(within(dialog).getByText('Customized settings'))
    fireEvent.change(within(dialog).getByLabelText('API endpoint'), { target: { value: 'https://gateway.example/anthropic' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('Saved DeepSeek.')).toBeTruthy()
    expect(api.saveModel).toHaveBeenCalledWith({
      ns: 'roleplay-model', revision: 3, api_key: 'sk-entered',
      ops: [{ op: 'set', path: ['baseURL'], value: 'https://gateway.example/anthropic' }],
    })
    expect(within(dialog).getByRole('button', { name: 'Edit DeepSeek' })).toBeTruthy()
    expect(api.turn).not.toHaveBeenCalled()
  })
  it('edits the model catalog as a whole override and removes a stored key on request', async () => {
    const api = makeApi()
    mount(api)
    await screen.findByText('Your first story is waiting')
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit DeepSeek' }))
    expect(screen.getByLabelText('API key')).toHaveProperty('placeholder', 'Configured — enter a new value to replace')
    openDetails(screen.getByText('Customized settings'))
    expect(screen.getByText('Using the adapter default models')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    expect(screen.getByText('Model 2: Model ID is required.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Model ID 2'), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(api.saveModel).toHaveBeenCalledTimes(1) })
    expect(api.saveModel).toHaveBeenCalledWith({
      ns: 'roleplay-model', revision: 3,
      ops: [{ op: 'set', path: ['models'], value: [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-v4-pro' }] }],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit DeepSeek' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => { expect(api.clearModelKey).toHaveBeenCalledWith('roleplay-model') })
  })
  it('reports a refused Models write in the card, keeps the draft and updates the reply banner from the result', async () => {
    let attempts = 0
    let stored = false
    const api = makeApi({
      // Status needs the Registry; while it is unreachable the page keeps the key state the Models write returned.
      status: vi.fn(async () => {
        if (stored) throw new RoleplayApiError('roleplay_app.connection_lost')
        return { ...status, model: { ...status.model, credential: { configured: false, writable: true } } }
      }),
      models: vi.fn(async () => providers()),
      saveModel: vi.fn(async () => {
        attempts++
        if (attempts === 1) throw new RoleplayApiError('roleplay_app.settings_conflict')
        stored = true
        return providers({ configured: true, source: 'file', writable: true })
      }),
    })
    mount(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Models' }))
    const key = await screen.findByLabelText('API key')
    fireEvent.change(key, { target: { value: 'sk-entered' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/These settings changed while the card was open/)).toBeTruthy()
    expect(screen.getByLabelText('API key')).toHaveProperty('value', 'sk-entered')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved DeepSeek.')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByText('Add a model API key in Settings before replying.')).toBeNull() })
  })
  it('keeps a launching-environment key and an overlay-owned provider read-only', async () => {
    const api = makeApi({
      models: vi.fn(async () => providers({ configured: true, source: 'env', writable: false }, { settings_writable: false })),
    })
    mount(api)
    await screen.findByText('Your first story is waiting')
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit DeepSeek' }))
    expect(screen.getByLabelText('API key')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('API key')).toHaveProperty('placeholder', 'Provided by the launch environment (read-only)')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    openDetails(screen.getByText('Customized settings'))
    expect(screen.getByText(/A --patch overlay configures this entry/)).toBeTruthy()
    expect(screen.getByLabelText('API endpoint')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    expect(api.saveModel).not.toHaveBeenCalled()
  })
  it('lists running plugins in Settings and saves a generated plugin form from the sidebar page', async () => {
    const api = makeApi()
    mount(api)
    await screen.findByText('Your first story is waiting')
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Built-in plugins' }))
    expect(await screen.findByText('char.pub roleplay')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), { target: { value: 'broken' } })
    expect(screen.queryByText('char.pub roleplay')).toBeNull()
    expect(screen.getByText('Failed to start')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    expect(await screen.findByRole('heading', { name: 'Plugins' })).toBeTruthy()
    expect(screen.getAllByText('Launch configuration').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Open Pacing' }))
    const scenes = await screen.findByLabelText('scenes')
    expect(screen.getByText('Scenes per chapter')).toBeTruthy()
    fireEvent.change(scenes, { target: { value: '0' } })
    expect(screen.getByText('Enter a value this field accepts.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    fireEvent.change(scenes, { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved. The running plugin uses the new values.')).toBeTruthy()
    expect(api.savePluginConfig).toHaveBeenCalledWith({ ns: 'pace', revision: 1, ops: [{ op: 'set', path: ['scenes'], value: 5 }] })
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(api.savePluginConfig).toHaveBeenLastCalledWith({ ns: 'pace', revision: 2, ops: [{ op: 'unset', path: ['scenes'] }] }) })
    fireEvent.click(screen.getByRole('button', { name: 'Back to plugin list' }))
    fireEvent.click(await screen.findByRole('button', { name: /Open llm-deepseek-api-key/ }))
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy()
  })
  it('starts export with empty synthetic inputs and invalidates an old file review on edits', async () => {
    const s = snapshot('first', {
      late_slots: [{ key: 'visitor', accepts: ['persona'], required: true, used_by: [], hint: 'Visitor' }],
    })
    const api = await active(
      makeApi({
        status: vi.fn(async () => ({ ...status, current_session: s.session })),
        session: vi.fn(async () => s),
      }),
    )
    reply('Private unsent reply')
    fireEvent.click(screen.getByRole('button', { name: 'Bring a moment back to char.pub' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: 'Synthetic summary' })).toHaveProperty('value', '')
    expect(within(dialog).getByRole('textbox', { name: 'Character name' })).toHaveProperty('value', '')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Synthetic summary' }), {
      target: { value: 'A visitor arrives at a public inn.' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Character name' }), {
      target: { value: 'Synthetic visitor' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review preview file' }))
    await within(dialog).findByRole('button', { name: 'Confirm and download' })
    expect(api.prepareExport).toHaveBeenCalledWith({
      session: s.session,
      history: [{ role: 'user', text: 'A visitor arrives at a public inn.' }],
      bindings: { visitor: { kind: 'persona', display_name: 'Synthetic visitor' } },
    })
    expect(JSON.stringify(vi.mocked(api.prepareExport).mock.calls)).not.toContain('Private unsent reply')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Synthetic summary' }), {
      target: { value: 'Revised summary' },
    })
    expect(within(dialog).queryByRole('button', { name: 'Confirm and download' })).toBeNull()
    expect(api.exportPreview).not.toHaveBeenCalled()
  })
  it('blocks competing navigation during bootstrap and restores only the server current session', async () => {
    const initial = deferred<AppStatus>()
    const api = makeApi({ status: vi.fn(() => initial.promise) })
    mount(api)
    expect(screen.getByRole('button', { name: 'New story' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'New story' }))
    await act(async () => {
      initial.resolve({ ...status, current_session: 'old-handle' })
    })
    await screen.findByRole('textbox', { name: 'Your next move' })
    expect(api.session).toHaveBeenCalledWith('old-handle')
    expect(api.start).not.toHaveBeenCalled()
  })
  it('finishes the bounded record read before reviewing a restored launch', async () => {
    sessionStorage.setItem('roleplay-launch', '{"source":"exact"}')
    const listing = deferred<{ items: [] }>()
    const api = makeApi({ sessions: vi.fn(() => listing.promise) })
    mount(api)
    await waitFor(() => {
      expect(api.sessions).toHaveBeenCalledTimes(1)
    })
    expect(api.review).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'New story' })).toHaveProperty('disabled', true)
    await act(async () => {
      listing.resolve({ items: [] })
    })
    await screen.findByText('An unexpected arrival')
    expect(api.review).toHaveBeenCalledTimes(1)
  })
  it('asks for Registry authorization before attempting a private launch review', async () => {
    sessionStorage.setItem('roleplay-launch', '{"source":"private-draft"}')
    const api = makeApi({
      status: vi.fn(async () => ({ ...status, registry: { ...status.registry, authorization: 'required' as const } })),
    })
    mount(api)
    await screen.findByText('This story is ready to review. Authorize char.pub access to open its exact version.')
    expect(screen.getByRole('button', { name: 'Authorize access' })).toBeTruthy()
    expect(api.review).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
