/** Local review of an explicit Ending; only the confirmed contribution request crosses the Registry wire. */
import {
  ChangeSchema, ExactRefSchema, StoryEndingSchema, canonicalCompositionValue, checkCreation,
  compositionDigest, digestExactJSON, mergeContribution,
  type CreationMeta, type ExactRef, type Story,
} from '@char-pub/core'
import { CreateContributionRequestSchema, RightsAckSchema } from '@char-pub/contracts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { z } from 'zod'
import type { RoleplayProjection } from './projection.ts'
import type { RegistryClient } from './registry/client.ts'

type Rights = z.infer<typeof RightsAckSchema>
type Request = z.infer<typeof CreateContributionRequestSchema>
type Ending = NonNullable<Story['endings']>[number]
/** Caller-authored or externally drafted input. Providing it never constitutes user confirmation. */
export interface EndingProposalInput {
  session: SessionId
  ending: unknown
  title: string
  description?: string
  rights_ack: Rights
}
/** Complete local review; only request is transmitted, and historical metadata is not current draft policy. */
export interface EndingProposal {
  target: { ref: string; source: ExactRef; label: string; revision: string }
  metadata: {
    source_rating: CreationMeta['rating']
    source_license: string
    source_content_warnings: string[]
  }
  ending: Ending
  request: Request
  session: { id: SessionId; head: string; state_digest: string }
  authorization_version: number
  digest: string
}
/** A separate user action must supply the exact reviewed digest and the same explicit rights grant. */
export interface EndingConfirmation { candidate_digest: string; rights_ack: Rights }
/** Local preparation and one attempted submission; no model invocation, Session write or publication. */
export interface EndingProposals {
  /** Bind an explicit new Ending to a committed published Scenario and its immutable Registry baseline. */
  prepare(input: EndingProposalInput, signal?: AbortSignal): Promise<EndingProposal>
  /** Recheck the committed snapshot before dispatch preparation; later play is not locked. Attempted requests cannot retry. */
  submit(candidate: EndingProposal, confirmation: EndingConfirmation, signal?: AbortSignal): ReturnType<RegistryClient['contribute']>
}
/** Dependencies remain caller-owned; inspect must reconstruct committed Session facts. */
export interface EndingProposalServices {
  registry: Pick<RegistryClient, 'releaseSource' | 'contribute' | 'authorizationVersion'>
  inspect: (id: SessionId) => Promise<RoleplayProjection>
}
function fail(reason: string): never { throw new Error(`roleplay_proposal.${reason}`) }
function cancelled(signal?: AbortSignal) { if (signal?.aborted) fail('cancelled') }
function digest(candidate: Omit<EndingProposal, 'digest'>) { return digestExactJSON(candidate) }
function unchanged(candidate: EndingProposal, expected: string) {
  const { digest: claimed, ...review } = candidate
  if (claimed !== expected || digest(review) !== expected) fail('review_changed')
}

/**
 * Create process-local review tickets without persisting or transmitting runtime records.
 * @param services - Existing authenticated Registry client and authoritative local Session reader.
 * @returns Prepare/submit operations; caller UI owns the separate user review and confirmation action.
 */
export function createEndingProposals(services: EndingProposalServices): EndingProposals {
  const { registry, inspect } = services
  const tickets = new WeakMap<EndingProposal, { review: EndingProposal; attempted: boolean; checking: boolean }>()
  return {
    async prepare(input, signal) {
      cancelled(signal)
      const authorizationVersion = registry.authorizationVersion()
      const intent = structuredClone(input)
      const projection = await inspect(intent.session)
      cancelled(signal)
      if (projection.pending) fail('request_pending')
      const artifact = projection.log.input.artifact
      if (artifact.kind !== 'content' || !artifact.story || !('release' in artifact.root)) fail('published_story_required')
      const source = ExactRefSchema.parse(artifact.root)
      const baseline = await registry.releaseSource(source, signal)
      cancelled(signal)
      const creation = baseline.source.creation
      if (creation.type !== 'scenario' || !creation.story || !('ref' in baseline.release.receipt)) fail('published_story_required')
      const requestedEnding = StoryEndingSchema.parse(intent.ending)
      if (creation.story.endings?.some(ending => ending.id === requestedEnding.id)) fail('ending_exists')
      const address = { on: 'story' as const, kind: 'ending' as const, id: requestedEnding.id }
      const ending = StoryEndingSchema.parse(canonicalCompositionValue(address, requestedEnding))
      const order = { on: 'story-order' as const, list: 'endings' as const }
      const changes = [
        ChangeSchema.parse({ ...address, op: 'add', after: ending }),
        ChangeSchema.parse({ ...order, op: 'set', base_digest: compositionDigest(creation, order),
          after: [...(creation.story.endings ?? []).map(item => item.id), ending.id] }),
      ]
      const merged = mergeContribution(creation, changes, creation)
      if (!merged.result || !checkCreation(merged.result.creation).ok) fail('invalid_ending')
      const request = CreateContributionRequestSchema.parse({
        changes_version: 1, title: intent.title, ...(intent.description === undefined ? {} : { description: intent.description }),
        base_revision: baseline.source.revision, changes, rights_ack: RightsAckSchema.parse(intent.rights_ack), agent: true,
      })
      const review = {
        target: { ref: baseline.release.receipt.ref, source, label: baseline.release.receipt.label, revision: baseline.source.revision },
        metadata: { source_rating: creation.meta.rating, source_license: creation.meta.license,
          source_content_warnings: [...(creation.meta.content_warnings ?? [])] },
        ending,
        request,
        session: { id: intent.session, head: projection.head, state_digest: digestExactJSON(projection.current.state) },
      }
      if (registry.authorizationVersion() !== authorizationVersion) fail('authorization_changed')
      const bound = { ...review, authorization_version: authorizationVersion }
      const candidate: EndingProposal = { ...bound, digest: digest(bound) }
      tickets.set(candidate, { review: structuredClone(candidate), attempted: false, checking: false })
      return candidate
    },
    async submit(candidate, confirmation, signal) {
      cancelled(signal)
      const ticket = tickets.get(candidate)
      if (!ticket) fail('unknown_review')
      if (ticket.attempted || ticket.checking) fail('already_submitted')
      unchanged(candidate, ticket.review.digest)
      if (registry.authorizationVersion() !== ticket.review.authorization_version) fail('authorization_changed')
      if (confirmation.candidate_digest !== ticket.review.digest
        || digestExactJSON(RightsAckSchema.parse(confirmation.rights_ack)) !== digestExactJSON(ticket.review.request.rights_ack))
        fail('confirmation_mismatch')
      ticket.checking = true
      try {
        const current = await inspect(ticket.review.session.id)
        cancelled(signal)
        unchanged(candidate, ticket.review.digest)
        if (registry.authorizationVersion() !== ticket.review.authorization_version) fail('authorization_changed')
        if (current.pending || current.head !== ticket.review.session.head
          || digestExactJSON(current.current.state) !== ticket.review.session.state_digest) fail('session_changed')
        // An attempted request stays consumed even when cancellation or a network error makes its outcome uncertain.
        ticket.attempted = true
        try {
          return await registry.contribute(
            ticket.review.target.ref, structuredClone(ticket.review.request),
            { confirmed: true, expectedAuthorizationVersion: ticket.review.authorization_version }, signal,
          )
        } catch (error) {
          if (error instanceof Error && (/^registry\.http_4\d\d$/.test(error.message)
            || error.message === 'registry.authorization_changed')) throw error
          throw new Error('roleplay_proposal.outcome_unknown', { cause: error })
        }
      } finally { ticket.checking = false }
    },
  }
}
