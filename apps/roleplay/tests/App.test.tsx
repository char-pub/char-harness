/** Browser interactions use authoritative DTO fixtures; these tests do not claim model quality or online connectivity. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AppLaunchReview,
  AppSessionSnapshot,
  AppStatus,
  AppTurnResult,
  AppTurnRequest,
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
    provider: 'configured-provider',
    id: 'configured-model',
    credential: { configured: true, source: 'file', writable: true },
    online_verified: false,
  },
  operation: null,
  limitations: [],
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
    saveCredential: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
    clearCredential: vi.fn(async () => ({ configured: false, writable: true })),
    prepareExport: vi.fn(async () => ({ digest: 'review-digest', payload: { synthetic: true } })),
    exportPreview: vi.fn(async () => ({ json: '{"synthetic":true}', payload: { synthetic: true } })),
    ...overrides,
  }
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Model' }))
    expect(within(dialog).getByText('Not verified online yet')).toBeTruthy()
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
  it('stores and removes the model API key only through explicit settings actions', async () => {
    const api = makeApi({
      status: vi.fn(async () => ({ ...status, model: { ...status.model, credential: { configured: false, writable: true } } })),
    })
    mount(api)
    expect(await screen.findByText('Add a model API key in Settings before replying.')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByText('Not configured')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: '  sk-entered  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('API key saved. The next reply uses it.')).toBeTruthy()
    expect(api.saveCredential).toHaveBeenCalledWith('sk-entered')
    expect(screen.getByText('Configured')).toBeTruthy()
    expect(screen.getByLabelText('API key')).toHaveProperty('value', '')
    expect(screen.queryByText('Add a model API key in Settings before replying.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('API key removed.')).toBeTruthy()
    expect(api.clearCredential).toHaveBeenCalledTimes(1)
    expect(api.turn).not.toHaveBeenCalled()
  })
  it('explains a launching-environment key without offering a write that it would shadow', async () => {
    const api = makeApi({
      status: vi.fn(async () => ({ ...status, model: { ...status.model, credential: { configured: true, source: 'env', writable: false } } })),
      saveCredential: vi.fn(async () => {
        throw new RoleplayApiError('roleplay_app.credential_read_only')
      }),
    })
    mount(api)
    await screen.findByText('Your first story is waiting')
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByText('Supplied by the launching environment. Change it there and restart the Runtime.')).toBeTruthy()
    expect(screen.getByLabelText('API key')).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(api.saveCredential).not.toHaveBeenCalled()
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
