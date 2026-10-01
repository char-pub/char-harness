/** Reviewed new sequel openings; existing Session facts are never uploaded as a saved game. */
import {
  ExactRefSchema, StoryContinuationInputSchema, UnversionedRefSchema, digestExactJSON, validateStoryState,
  type CreationMeta, type ExactRef, type LocalizedTemplateText, type LocalizedText,
} from '@char-pub/core'
import { DeriveCreationRequestSchema } from '@char-pub/contracts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { z } from 'zod'
import type { RoleplayProjection } from './projection.ts'
import type { RegistryClient } from './registry/client.ts'

type Request = z.infer<typeof DeriveCreationRequestSchema>
type Rights = Request['rights_ack']
/** An explicitly edited opening and new work address. Preparation does not authorize creation. */
export interface StoryContinuationIntent {
  session: SessionId
  namespace: string
  name: string
  display_name: LocalizedText
  opening: LocalizedTemplateText
  agent: boolean
  rights_ack: Rights
}
/** Complete local review; only request and target.namespace cross the Registry boundary. */
export interface StoryContinuationReview {
  source: { exact: ExactRef; label: string; revision: string }
  target: { namespace: string; name: string; display_name: LocalizedText }
  metadata: {
    source_rating: CreationMeta['rating']
    source_license: string
    source_content_warnings: string[]
    effective_rating: CreationMeta['rating']
    effective_content_warnings: string[]
  }
  request: Request
  reset: { visited: 'opening-scene-only'; reached: []; ended: []; happened: []; stopped: false }
  session: { id: SessionId; head: string; state_digest: string }
  authorization_version: number
  digest: string
}
/** A separate user confirmation binds both the reviewed bytes and their rights acknowledgement. */
export interface StoryContinuationConfirmation { candidate_digest: string; rights_ack: Rights }
/** Caller-owned dependencies are captured once; inspect must reconstruct committed local facts. */
export interface StoryContinuationServices {
  registry: Pick<RegistryClient, 'releaseSource' | 'derive' | 'authorizationVersion'>
  inspect: (id: SessionId) => Promise<RoleplayProjection>
}
/** No model invocation, Session write, automatic publication or lossless saved-game restoration. */
export interface StoryContinuations {
  /** Read an exact published Scenario and project only reviewed initial-situation fields from committed state. */
  prepare(input: StoryContinuationIntent, signal?: AbortSignal): Promise<StoryContinuationReview>
  /** Recheck the snapshot before submission; subsequent gameplay is not locked. Each attempted creation is consumed. */
  submit(
    review: StoryContinuationReview, confirmation: StoryContinuationConfirmation, signal?: AbortSignal,
  ): ReturnType<RegistryClient['derive']>
}
function fail(reason: string): never { throw new Error(`roleplay_continuation.${reason}`) }
function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail('cancelled') }
function unchanged(candidate: StoryContinuationReview, expected: string) {
  const { digest, ...review } = candidate
  if (digest !== expected || digestExactJSON(review) !== expected) fail('review_changed')
}

/**
 * Prepare a new sequel from a reviewed situation, with no generated target ID or local pretend derivation.
 * @param services - Authenticated Registry client and authoritative Session inspection, captured for this instance.
 * @returns Local review and one-attempt confirmed creation; the Registry owns identity, licenses and asset grants.
 */
export function createStoryContinuations(services: StoryContinuationServices): StoryContinuations {
  const { registry, inspect } = services
  const tickets = new WeakMap<StoryContinuationReview, { review: StoryContinuationReview; checking: boolean; attempted: boolean }>()
  return {
    async prepare(input, signal) {
      cancelled(signal)
      const intent = structuredClone(input)
      const authorizationVersion = registry.authorizationVersion()
      UnversionedRefSchema.parse(`@${intent.namespace}/${intent.name}`)
      const projection = await inspect(intent.session)
      cancelled(signal)
      if (projection.pending) fail('request_pending')
      const artifact = projection.log.input.artifact
      if (artifact.kind !== 'content' || !artifact.story || !('release' in artifact.root)) fail('published_story_required')
      const exact = ExactRefSchema.parse(artifact.root)
      const baseline = await registry.releaseSource(exact, signal)
      cancelled(signal)
      const creation = baseline.source.creation
      if (creation.type !== 'scenario' || !creation.story || !('ref' in baseline.release.receipt)) fail('published_story_required')
      const state = projection.current.state
      validateStoryState(creation.story, (creation.cast ?? []).map(member => member.key), state)
      const fromPlay = StoryContinuationInputSchema.parse({
        scene: state.scene, present: state.present, vars: state.vars, knowing: state.knowing, opening: intent.opening,
      })
      const request = DeriveCreationRequestSchema.parse({
        kind: 'sequel', source: exact, name: intent.name, display_name: intent.display_name,
        from_play: fromPlay, agent: intent.agent, rights_ack: intent.rights_ack,
      })
      const bound: Omit<StoryContinuationReview, 'digest'> = {
        source: { exact, label: baseline.release.receipt.label, revision: baseline.source.revision },
        target: { namespace: intent.namespace, name: request.name, display_name: request.display_name },
        metadata: { source_rating: creation.meta.rating, source_license: creation.meta.license,
          source_content_warnings: [...(creation.meta.content_warnings ?? [])],
          effective_rating: artifact.meta.rating, effective_content_warnings: [...artifact.meta.content_warnings] },
        request,
        reset: { visited: 'opening-scene-only', reached: [], ended: [], happened: [], stopped: false },
        session: { id: intent.session, head: projection.head, state_digest: digestExactJSON(state) },
        authorization_version: authorizationVersion,
      }
      if (registry.authorizationVersion() !== authorizationVersion) fail('authorization_changed')
      const review = { ...bound, digest: digestExactJSON(bound) }
      tickets.set(review, { review: structuredClone(review), checking: false, attempted: false })
      return review
    },
    async submit(review, confirmation, signal) {
      cancelled(signal)
      const ticket = tickets.get(review)
      if (!ticket) fail('unknown_review')
      if (ticket.attempted || ticket.checking) fail('already_submitted')
      unchanged(review, ticket.review.digest)
      if (registry.authorizationVersion() !== ticket.review.authorization_version) fail('authorization_changed')
      if (confirmation.candidate_digest !== ticket.review.digest
        || digestExactJSON(confirmation.rights_ack) !== digestExactJSON(ticket.review.request.rights_ack)) fail('confirmation_mismatch')
      ticket.checking = true
      try {
        const current = await inspect(ticket.review.session.id)
        cancelled(signal)
        unchanged(review, ticket.review.digest)
        if (registry.authorizationVersion() !== ticket.review.authorization_version) fail('authorization_changed')
        if (current.pending || current.head !== ticket.review.session.head
          || digestExactJSON(current.current.state) !== ticket.review.session.state_digest) fail('session_changed')
        ticket.attempted = true
        try {
          return await registry.derive(ticket.review.target.namespace, structuredClone(ticket.review.request),
            { confirmed: true, expectedAuthorizationVersion: ticket.review.authorization_version }, signal)
        } catch (error) {
          if (error instanceof Error && (/^registry\.http_4\d\d$/.test(error.message)
            || error.message === 'registry.authorization_changed')) throw error
          throw new Error('roleplay_continuation.outcome_unknown', { cause: error })
        }
      } finally { ticket.checking = false }
    },
  }
}
