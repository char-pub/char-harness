/** Explicit synthetic preview exports; runtime dialogue and loaded Source bodies are never copied. */
import {
  buildIdentity, digestExactJSON, MAX_RUNTIME_PREVIEW_BYTES, toTurnStory,
  type BuildRef, type HistoryMessage, type RuntimePreviewInput, type Session,
} from '@char-pub/core'
import { isTokenizerName, TOKENIZER_VERSIONS, validateRuntimePreviewInput } from '@char-pub/assembler'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RoleplayProjection } from './projection.ts'

/** Callers supply synthetic messages and identities explicitly after editing their summaries. */
export interface RuntimePreviewExportInput {
  session: SessionId
  history: HistoryMessage[]
  bindings: Session['bindings']
  for_participant?: string
  story_guidance?: boolean
}
/** Local-only review identity is never part of the exported protocol payload. */
export interface RuntimePreviewExportReview {
  payload: RuntimePreviewInput
  digest: string
  session: { id: SessionId; head: string; state_digest: string }
}
/** A JSON file payload after explicit confirmation; no download, HTTP or filesystem write occurs. */
export interface RuntimePreviewExportResult {
  payload: RuntimePreviewInput
  json: string
}
/** Separate preparation and confirmation over an authoritative committed Session snapshot. */
export interface RuntimePreviewExports {
  /** Read committed state and combine it only with caller-supplied synthetic history and bindings. */
  prepare(input: RuntimePreviewExportInput, signal?: AbortSignal): Promise<RuntimePreviewExportReview>
  /** Recheck unchanged local state and exact review; repeat confirmation may return identical JSON. */
  export(
    review: RuntimePreviewExportReview, confirmation: { candidate_digest: string }, signal?: AbortSignal,
  ): Promise<RuntimePreviewExportResult>
}
/** The reader belongs to the local Runtime and must reconstruct committed Session state. */
export interface RuntimePreviewExportServices {
  inspect: (id: SessionId) => Promise<RoleplayProjection>
}
function fail(reason: string): never { throw new Error(`roleplay_preview.${reason}`) }
function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail('cancelled') }
function available(root: BuildRef) {
  if ('origin' in root && root.origin.kind === 'draft-build' && Date.parse(root.origin.expires_at) <= Date.now())
    fail('source_expired')
}
function reviewDigest(review: Omit<RuntimePreviewExportReview, 'digest'>) { return digestExactJSON(review) }

/**
 * Create a local preview export flow without reading any Registry or changing any Session.
 * @param services - Authoritative local Session inspection; captured once for this exporter instance.
 * @returns Review/confirm methods; caller UI must show the whole payload before asking for its digest confirmation.
 */
export function createRuntimePreviewExports(services: RuntimePreviewExportServices): RuntimePreviewExports {
  const { inspect } = services
  const tickets = new WeakMap<RuntimePreviewExportReview, RuntimePreviewExportReview>()
  return {
    async prepare(input, signal) {
      cancelled(signal)
      const intent = structuredClone(input)
      const projection = await inspect(intent.session)
      cancelled(signal)
      if (projection.pending) fail('request_pending')
      const artifact = projection.log.input.artifact
      if (artifact.kind !== 'content' || !artifact.story) fail('story_required')
      available(artifact.root)
      const policy = artifact.assembly?.preset ?? artifact.default_policy
      if (!policy) fail('preset_missing')
      const preset: BuildRef = { ref: policy.ref, semantic_digest: policy.semantic_digest,
        ...buildIdentity(policy) }
      const originalProfile = projection.log.input.profile
      if (originalProfile.mode === 'per-agent' && intent.for_participant === undefined) fail('view_required')
      const locale = projection.current.turn.locale ?? originalProfile.locale ?? artifact.ir.meta.default_locale
      const tokenizer = originalProfile.tokenizer
      if (!isTokenizerName(tokenizer)) fail('tokenizer_unsupported')
      const payload = validateRuntimePreviewInput(artifact, {
        format: 'char.pub/runtime-preview', version: 1,
        source: { root: artifact.root, lock_digest: artifact.lock_digest, artifact_json_digest: digestExactJSON(artifact) },
        profile: { ...originalProfile, locale }, preset,
        tokenizer: { name: tokenizer, version: TOKENIZER_VERSIONS[tokenizer] },
        turn: {
          locale, history: intent.history, bindings: intent.bindings,
          scene: projection.current.state.scene, present: [...projection.current.state.present],
          story: toTurnStory(projection.current.state),
          ...(intent.for_participant === undefined ? {} : { for_participant: intent.for_participant }),
          ...(intent.story_guidance === undefined ? {} : { story_guidance: intent.story_guidance }),
        },
      })
      const local = { payload,
        session: { id: intent.session, head: projection.head, state_digest: digestExactJSON(projection.current.state) },
      }
      const review = { ...local, digest: reviewDigest(local) }
      tickets.set(review, structuredClone(review))
      return review
    },
    async export(review, confirmation, signal) {
      cancelled(signal)
      const ticket = tickets.get(review)
      if (!ticket) fail('unknown_review')
      const unchanged = () => {
        const { digest, ...local } = review
        if (digest !== ticket.digest || reviewDigest(local) !== ticket.digest) fail('review_changed')
      }
      unchanged()
      if (confirmation.candidate_digest !== ticket.digest) fail('confirmation_mismatch')
      const current = await inspect(ticket.session.id)
      cancelled(signal)
      unchanged()
      if (current.pending || current.head !== ticket.session.head
        || digestExactJSON(current.current.state) !== ticket.session.state_digest) fail('session_changed')
      available(current.log.input.artifact.root)
      const payload = validateRuntimePreviewInput(current.log.input.artifact, ticket.payload)
      const json = JSON.stringify(payload)
      if (Buffer.byteLength(json, 'utf8') > MAX_RUNTIME_PREVIEW_BYTES) fail('too_large')
      cancelled(signal)
      return { payload, json }
    },
  }
}
