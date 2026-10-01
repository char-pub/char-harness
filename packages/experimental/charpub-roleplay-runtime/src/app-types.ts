/** Browser DTOs for the same-origin roleplay app. This module contains only types. */
import type { CapabilitySupportReport, CreationArtifact, ContextIR, HistoryMessage, Session } from '@char-pub/core'

/** Localized, displayable work identity; exact SDK identities stay available for advanced review. */
export interface AppWork {
  title: string
  summary?: string
  source: CreationArtifact['root']
  source_label: string
  locale: string
}
/** One visible participant; descriptions come from the current SDK view rather than all authored fragments. */
export interface AppParticipant {
  key: string
  name: string
  present: boolean
  role?: string
  goal?: string
}
/** Authoritative committed view after a local operation; no OAuth token or filesystem path. */
export interface AppSessionSnapshot {
  session: string
  record: string
  work: AppWork
  history: HistoryMessage[]
  participants: AppParticipant[]
  late_slots: ContextIR['late_slots']
  scene: { id: string; title: string; description?: string } | null
  stopped: boolean
  interrupted: boolean
  can_continue: boolean
  limitations: string[]
}
/** Registry authorization and fixed local model configuration, without an online inference probe. */
export interface AppStatus {
  registry: { origin: string; authorization: 'required' | 'authorized' }
  model: { provider: string; id: string; credential: 'unverified'; online_verified: false }
  operation: { kind: 'review' | 'start' | 'resume' | 'turn' | 'export'; session?: string; request_id?: string } | null
  current_session?: string
  limitations: string[]
}
/** A local record identifier is process-issued and never a caller-selected filesystem path. */
export interface AppSessionRecord {
  record: string
  created_at: string
  work?: AppWork
  state: 'ready' | 'stopped' | 'interrupted' | 'busy' | 'unreadable'
  error_code?: string
}
/** Bounded event-log reads; a cursor may lead to an empty page when unrelated local logs were filtered. */
export interface AppSessionsResponse { items: AppSessionRecord[]; next_cursor?: string }
/** Stable request identity generated once per user submission, including retries after an unknown response. */
export interface AppTurnRequest { session: string; request_id: string; text: string; recover_interrupted?: true }
/** A completed reply or failure, read from the same durable Session request. */
export interface AppTurnResult {
  request_id: string
  status: 'success' | 'cancelled' | 'failed'
  error_code?: string
  snapshot: AppSessionSnapshot
}
/** Inspect a request without dispatching it again. */
export type AppTurnStatus =
  | { request_id: string; status: 'sending' }
  | { request_id: string; status: 'not_found'; snapshot: AppSessionSnapshot }
  | AppTurnResult
/** Starting always creates a new log. Resuming is a separate explicit operation. */
export interface AppStartRequest {
  review: string
  bindings: Session['bindings']
  start?: string
  for_participant?: string
  restart: boolean
}
/** Stop only the addressed operation. Omit both identities to cancel launch review/start. */
export interface AppCancelRequest { session?: string; request_id?: string }
/** Exact version review before starting; no authored effects or private Story state are sent as setup metadata. */
export interface AppLaunchReview {
  review: string
  work: AppWork
  source: CreationArtifact['root']
  title: string
  metadata: CreationArtifact['meta']
  capabilities: CreationArtifact['capabilities']
  support: CapabilitySupportReport
  starts: Array<{ id: string; title: string; description?: string }>
  participants: Array<{ key: string; display_name: string; cast_key?: string }>
  late_slots: ContextIR['late_slots']
  locale: string
  start?: string
  view: { mode: 'narrator' } | { mode: 'per-agent'; for_participant: string }
  restart_required: boolean
  previous_source?: CreationArtifact['root']
}
