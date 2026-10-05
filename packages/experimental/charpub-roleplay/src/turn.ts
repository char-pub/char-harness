/** One player utterance and an ordered, Core-validated set of authored Story actions. */
import { CharError, DigestSchema, TurnViewSchema, digestExactJSON, availableChoices, playerInputMessage, resolveStoryPlayer } from '@char-pub/core'
import type { CreationArtifact, StoryJudgment, StoryState, TurnView } from '@char-pub/core'
import { localizedString } from '@char-pub/assembler'
import { z } from 'zod'

/** Player identity is an already resolved participant key; this layer never infers control from names. */
export const TurnInputSchema = z.strictObject({
  text: z.string(), speaker: z.string().min(1).optional(), choice_id: z.string().min(1).optional(),
}).refine(value => value.text.trim().length > 0 || value.choice_id !== undefined, 'Supply text or an authored choice')
/** Authored changes the director can propose; arbitrary effects and variable writes are excluded. */
export const StoryActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirm'), target: z.string().regex(/^(beat|event|ending)\/[a-z0-9][a-z0-9_-]*$/) }),
  z.strictObject({ kind: z.literal('enter-scene'), scene: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/) }),
])
/** Public decision codes, never the model's private reasoning. Accepted actions remain prospective until settlement. */
export const ActionAssessmentSchema = z.strictObject({
  target: z.string().min(1), status: z.enum(['accepted', 'skipped']), reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
})
/** A private, state-bound terminal proposal; only its public fields are suitable for the player UI. */
export const TurnEndingProposalSchema = z.strictObject({
  id: DigestSchema, target: z.string().regex(/^ending\/[a-z0-9][a-z0-9_-]*$/),
  source_turn_id: z.string().min(1), parent_head: DigestSchema, parent_revision: DigestSchema, state_digest: DigestSchema,
  judgments: TurnViewSchema.shape.judgments.unwrap(),
  public: z.strictObject({ title: z.string().optional(), description: z.string().optional(), triggering_input: z.string() }),
}).superRefine((proposal, ctx) => {
  const { id, ...fields } = proposal
  if (digestExactJSON(fields) !== id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'Ending proposal digest mismatch' })
})
/** Durable proposal bound to the turn that inferred it and the prospective committed Story state. */
export type TurnEndingProposal = z.infer<typeof TurnEndingProposalSchema>

/**
 * Express the stored eligibility decisions as part of an explicit player confirmation.
 * @param proposal - Exact server-owned pending proposal, retaining its original provider judgments.
 * @returns The same leaf values with a manual confirmation provider identity; no model is asked again.
 */
export function confirmedEndingJudgments(proposal: TurnEndingProposal): StoryJudgment[] {
  return proposal.judgments.map(judgment => ({ ...judgment, provider: { name: 'manual', version: '1' } }))
}

/** A single replay operation stages input and all its actions together. */
export const TurnOperationSchema = z.strictObject({
  kind: z.literal('turn'), input: TurnInputSchema,
  actions: z.array(StoryActionSchema), assessments: z.array(ActionAssessmentSchema),
  ending_proposal: TurnEndingProposalSchema.optional(), ending_confirmation: TurnEndingProposalSchema.optional(),
}).refine(value => !(value.ending_proposal && value.ending_confirmation), 'A turn proposes or confirms an ending, not both')
/** Original user text with an optional authored choice and explicit participant identity. */
export type TurnInput = z.infer<typeof TurnInputSchema>
/** One authored confirmation or scene transition; arbitrary effects are excluded. */
export type StoryAction = z.infer<typeof StoryActionSchema>
/** Accepted/skipped target and a safe reason code, separate from private model reasoning. */
export type ActionAssessment = z.infer<typeof ActionAssessmentSchema>
/** One atomic replay operation containing input, ordered actions and their assessments. */
export type TurnOperation = z.infer<typeof TurnOperationSchema>

/**
 * Return the canonical target of a validated action.
 * @param action - An authored scene transition or confirmation.
 * @returns The Core target identifier.
 */
export function actionTarget(action: StoryAction): string {
  return action.kind === 'confirm' ? action.target : `scene/${action.scene}`
}

/**
 * Append current player evidence before judging prospective effects.
 * @param artifact - Fixed content with its authored choices and participants.
 * @param state - Committed state used to admit an explicit choice.
 * @param turn - Prior dialogue and visible runtime context.
 * @param input - Original text, optional explicit choice and resolved speaker.
 * @returns A detached turn containing exactly one new user message.
 */
export function appendTurnInput(
  artifact: Extract<CreationArtifact, { kind: 'content' }>, state: StoryState, turn: TurnView,
  input: TurnInput,
): TurnView {
  if (input.speaker && !artifact.ir.participants.some(participant => participant.key === input.speaker))
    throw new CharError({ code: 'roleplay.speaker_missing', subject: input.speaker })
  const player = resolveStoryPlayer(artifact)
  if (player && input.speaker && input.speaker !== player.participant)
    throw new CharError({ code: 'roleplay.player_speaker_mismatch', subject: input.speaker })
  let text = input.text
  if (input.choice_id !== undefined) {
    const story = artifact.story
    const cast = Object.keys(artifact.story_refs?.participants ?? {})
    if (!story || !availableChoices(story, cast, state, turn.judgments ?? []).includes(input.choice_id))
      throw new CharError({ code: 'roleplay.choice_unavailable', subject: input.choice_id })
    const choice = story.choices?.find(item => item.id === input.choice_id)
    if (!choice) throw new CharError({ code: 'roleplay.choice_unavailable', subject: input.choice_id })
    const intent = localizedString(choice.intent, turn.locale ?? artifact.meta.default_locale, artifact.meta.default_locale)
    text = !text.trim() || text === intent ? intent : `${text}\n\n${intent}`
  }
  const message = playerInputMessage(artifact, text)
  return { ...turn, history: [...turn.history, { ...message, ...(!player && input.speaker ? { speaker: input.speaker } : {}) }] }
}
