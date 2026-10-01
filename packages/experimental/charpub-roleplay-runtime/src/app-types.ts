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
/** Presence of the configured model credential reference; never the value. A configured key is not an online check. */
export interface AppCredentialState {
  configured: boolean
  /** Credential provider source layer, such as `env` or `file`; absent while unconfigured. */
  source?: string
  /** False while a read-only layer such as the launching environment supplies the reference. */
  writable: boolean
}
/** Store one non-empty model API key in the profile's writable credential source. */
export interface AppCredentialRequest { value: string }
/** JSON value carried by a settings form; secrets are redacted before they reach the browser. */
export type AppJson = string | number | boolean | null | AppJson[] | { [key: string]: AppJson }
/** One path-addressed edit to a profile entry's user section. */
export type AppSettingsPathOp = { op: 'set'; path: string[]; value: AppJson } | { op: 'unset'; path: string[] }
/** A settings write fenced by the revision the form was read at. */
export interface AppSettingsWrite { ns: string; ops: AppSettingsPathOp[]; revision?: number }
/** Live configuration form of one profile entry: serialized schemastery schema and redacted layers. */
export interface AppSettingsForm {
  schema: unknown
  /** Effective value: schema defaults, then bundle layers, then the user section. */
  value: unknown
  /** Value without the user section. */
  base: unknown
  /** The profile's own section; a field present here is user-overridden. */
  user: unknown
  revision: number
  /** False while a command-line overlay owns this entry, so a profile write could not take effect. */
  writable: boolean
}
/** One configurable model provider as the Models page renders it. */
export interface AppModelProvider {
  provider: string
  display_name: string
  /** Profile entry id that owns this provider's settings. */
  ns: string
  /** Path from the section root to this provider's profile object. */
  path: string[]
  credential_ref: string
  credential: AppCredentialState
  /** False while a command-line overlay owns the provider entry. */
  settings_writable: boolean
  /** Absent while the owning entry exposes no live form. */
  form?: AppSettingsForm
}
/** Every configurable provider in declaration order. */
export interface AppModelsView { providers: AppModelProvider[] }
/** Write one provider card: settings path edits, then an optional new API key. */
export interface AppModelsWrite extends AppSettingsWrite { api_key?: string }
/** Localized text from a plugin package manifest or locale file. */
export type AppLocalizedText = string | { en: string; [locale: string]: string }
/** One Loader entry in the plugin list. */
export interface AppPluginEntry {
  entry_id: string
  /** Settings namespace (profile entry id). */
  ns: string
  module_name: string
  enabled: boolean
  phase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  /** `form`: a generated live form; `models`: configured on the Models page; `none`: launch configuration only. */
  configurable: 'form' | 'models' | 'none'
  /** False while a command-line overlay owns this entry. */
  settings_writable: boolean
  meta?: { title?: AppLocalizedText; description?: AppLocalizedText; icon?: string; error?: string }
}
/** Current plugin inventory of the running profile. */
export interface AppPluginsView { entries: AppPluginEntry[] }
/** One plugin's live form with its namespace. */
export interface AppPluginConfigView extends AppSettingsForm { ns: string }
/** Registry authorization and fixed local model configuration, without an online inference probe. */
export interface AppStatus {
  registry: { origin: string; authorization: 'required' | 'authorized' }
  model: { provider: string; id: string; credential: AppCredentialState; online_verified: false }
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
