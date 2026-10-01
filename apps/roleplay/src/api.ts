/** Same-origin transport for the named-profile app; model and Registry credentials stay on the host. */
import type {
  AppCancelRequest, AppCredentialState, AppLaunchReview, AppSessionSnapshot, AppSessionsResponse,
  AppStartRequest, AppStatus, AppTurnRequest, AppTurnResult, AppTurnStatus,
} from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'

/** Public page configuration. The nonce authorizes this local page, not a Registry or model request. */
export interface RoleplayBootstrap { nonce: string; registryOrigin: string }
/** A synthetic file is reviewed before a separate explicit download operation. */
export interface PreviewReview { digest: string; payload: Record<string, unknown> }
/** Downloadable local bytes returned after the host rechecks the reviewed Session head. */
export interface PreviewFile { json: string; payload: Record<string, unknown> }
/** Browser operations expose actual host results; no method starts a model request implicitly. */
export interface RoleplayApi {
  status(): Promise<AppStatus>
  sessions(cursor?: string): Promise<AppSessionsResponse>
  session(session: string): Promise<AppSessionSnapshot>
  review(launch: unknown): Promise<AppLaunchReview>
  start(input: AppStartRequest): Promise<AppSessionSnapshot>
  resume(record: string): Promise<AppSessionSnapshot>
  turn(input: AppTurnRequest): Promise<AppTurnResult>
  turnStatus(session: string, requestId: string): Promise<AppTurnStatus>
  cancel(input: AppCancelRequest): Promise<void>
  authorize(): Promise<{ authorizationURL: string }>
  /** Store the model API key in the profile's writable credential source; the value is never returned. */
  saveCredential(value: string): Promise<AppCredentialState>
  /** Remove the stored model API key; a read-only launching environment value remains in effect. */
  clearCredential(): Promise<AppCredentialState>
  prepareExport(input: { session: string; history: AppSessionSnapshot['history']; bindings: AppStartRequest['bindings'] }): Promise<PreviewReview>
  exportPreview(input: { session: string; digest: string }): Promise<PreviewFile>
}
/** A transport failure can leave an operation committed; the UI must inspect it before retrying. */
export class RoleplayApiError extends Error {
  constructor(readonly code: string, readonly unknownOutcome = false) {
    super(code)
    this.name = 'RoleplayApiError'
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function string(value: unknown): value is string { return typeof value === 'string' }
function objects(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(record)
}
function work(value: unknown): boolean {
  return record(value) && string(value.title) && string(value.locale) && string(value.source_label) && record(value.source)
}
function lateSlots(value: unknown): boolean {
  return objects(value) && value.every(slot => string(slot.key) && typeof slot.required === 'boolean'
    && Array.isArray(slot.accepts) && slot.accepts.length > 0 && slot.accepts.every(item => item === 'persona' || item === 'character')
    && Array.isArray(slot.used_by) && slot.used_by.every(string) && (slot.hint === undefined || string(slot.hint)))
}
function snapshot(value: unknown): value is AppSessionSnapshot {
  return record(value) && string(value.session) && string(value.record) && work(value.work) && lateSlots(value.late_slots)
    && objects(value.history) && value.history.every(item => string(item.role) && string(item.text))
    && objects(value.participants) && value.participants.every(item => string(item.key) && string(item.name) && typeof item.present === 'boolean')
    && (value.scene === null || (record(value.scene) && string(value.scene.id) && string(value.scene.title)))
    && typeof value.stopped === 'boolean' && typeof value.interrupted === 'boolean' && typeof value.can_continue === 'boolean'
    && Array.isArray(value.limitations) && value.limitations.every(string)
}
function credential(value: unknown): value is AppCredentialState {
  return record(value) && typeof value.configured === 'boolean' && typeof value.writable === 'boolean'
    && (value.source === undefined || string(value.source))
}
function status(value: unknown): value is AppStatus {
  return record(value) && record(value.registry) && string(value.registry.origin)
    && ['required', 'authorized'].includes(String(value.registry.authorization))
    && record(value.model) && string(value.model.provider) && string(value.model.id) && credential(value.model.credential)
    && value.model.online_verified === false && (value.operation === null || record(value.operation))
    && (value.current_session === undefined || string(value.current_session))
    && Array.isArray(value.limitations) && value.limitations.every(string)
}
function sessions(value: unknown): value is AppSessionsResponse {
  return record(value) && objects(value.items) && value.items.every(item => string(item.record) && string(item.created_at)
    && ['ready', 'stopped', 'interrupted', 'busy', 'unreadable'].includes(String(item.state)) && (item.work === undefined || work(item.work)))
    && (value.next_cursor === undefined || string(value.next_cursor))
}
function capabilities(value: unknown): boolean {
  return objects(value) && value.every(item => string(item.id) && (item.experimental === undefined || item.experimental === true))
}
function review(value: unknown): value is AppLaunchReview {
  return record(value) && string(value.review) && work(value.work) && string(value.title) && record(value.source)
    && record(value.metadata) && ['general', 'teen', 'mature', 'explicit'].includes(String(value.metadata.rating))
    && objects(value.metadata.licenses) && value.metadata.licenses.every(item => string(item.license))
    && Array.isArray(value.metadata.content_warnings) && value.metadata.content_warnings.every(string)
    && capabilities(value.capabilities) && record(value.support)
    && ['supported', 'degraded', 'unsupported'].includes(String(value.support.status))
    && capabilities(value.support.missing) && capabilities(value.support.degraded)
    && objects(value.support.degraded) && value.support.degraded.every(item => string(item.reason))
    && objects(value.starts) && value.starts.every(item => string(item.id) && string(item.title))
    && objects(value.participants) && value.participants.every(item => string(item.key) && string(item.display_name))
    && lateSlots(value.late_slots) && string(value.locale) && record(value.view)
    && (value.view.mode === 'narrator' || (value.view.mode === 'per-agent' && string(value.view.for_participant)))
    && typeof value.restart_required === 'boolean'
}
function turn(value: unknown): value is AppTurnResult {
  return record(value) && string(value.request_id) && ['success', 'cancelled', 'failed'].includes(String(value.status))
    && (value.error_code === undefined || string(value.error_code)) && snapshot(value.snapshot)
}
function turnStatus(value: unknown): value is AppTurnStatus {
  return turn(value) || (record(value) && string(value.request_id)
    && (value.status === 'sending' || (value.status === 'not_found' && snapshot(value.snapshot))))
}
function previewReview(value: unknown): value is PreviewReview {
  return record(value) && string(value.digest) && record(value.payload)
}
function previewFile(value: unknown): value is PreviewFile {
  return record(value) && string(value.json) && record(value.payload)
}
function authorization(value: unknown): value is { authorizationURL: string } {
  return record(value) && string(value.authorizationURL)
}

/** Read only the profile-injected public bootstrap; a missing server must never look like a working demo. */
export function readBootstrap(): RoleplayBootstrap {
  const content = document.getElementById('charpub-bootstrap')?.textContent
  if (!content) throw new RoleplayApiError('roleplay_app.bootstrap_missing')
  let value: unknown
  try { value = JSON.parse(content) }
  catch { throw new RoleplayApiError('roleplay_app.bootstrap_invalid') }
  if (!record(value) || !string(value.nonce) || !value.nonce || !string(value.registryOrigin)) throw new RoleplayApiError('roleplay_app.bootstrap_invalid')
  const origin = new URL(value.registryOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.registryOrigin) throw new RoleplayApiError('roleplay_app.bootstrap_invalid')
  return { nonce: value.nonce, registryOrigin: value.registryOrigin }
}

/**
 * Create the local page client without resolving credentials or probing an online model.
 * @param bootstrap - Public page configuration supplied by the profile's HTTP entry.
 * @param transport - Fetch implementation; tests may replace the network while keeping the wire validation.
 * @returns Typed operations with explicit unknown-outcome errors.
 */
export function createRoleplayApi(bootstrap: RoleplayBootstrap, transport: typeof fetch = fetch): RoleplayApi {
  async function call<T>(operation: string, input: unknown, validate: (value: unknown) => value is T, mutation = false): Promise<T> {
    let response: Response
    try {
      response = await transport(`/api/${operation}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-roleplay-client': bootstrap.nonce },
        body: JSON.stringify(input),
      })
    } catch { throw new RoleplayApiError('roleplay_app.connection_lost', mutation) }
    let value: unknown
    try { value = await response.json() }
    catch { throw new RoleplayApiError('roleplay_app.invalid_response', mutation) }
    if (!response.ok) {
      const code = record(value) && string(value.error) && /^[a-z_]+\.[a-z_0-9]+$/.test(value.error) ? value.error : 'roleplay_app.operation_failed'
      throw new RoleplayApiError(code, mutation && (response.status >= 500 || code === 'roleplay_app.operation_failed'))
    }
    if (!validate(value)) throw new RoleplayApiError('roleplay_app.invalid_response', mutation)
    return value
  }
  return {
    status: () => call('status', {}, status),
    sessions: cursor => call('sessions', cursor ? { cursor } : {}, sessions),
    session: session => call('session', { session }, snapshot),
    review: input => call('review', input, review),
    start: input => call('start', input, snapshot, true),
    resume: record => call('resume', { record, restart: true }, snapshot, true),
    turn: input => call('turn', input, turn, true),
    turnStatus: (session, requestId) => call('turn-status', { session, request_id: requestId }, turnStatus),
    cancel: async (input) => { await call('cancel', input, record, true) },
    authorize: async () => {
      const result = await call('authorize', {}, authorization)
      const target = new URL(result.authorizationURL)
      if (target.origin !== bootstrap.registryOrigin) throw new RoleplayApiError('roleplay_app.registry_mismatch')
      return result
    },
    saveCredential: value => call('credential', { value }, credential, true),
    clearCredential: () => call('credential-clear', {}, credential, true),
    prepareExport: input => call('prepare-export', input, previewReview),
    exportPreview: input => call('export', input, previewFile, true),
  }
}
