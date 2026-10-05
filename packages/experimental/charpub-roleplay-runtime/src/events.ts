/** Required roleplay Session facts; these events never join the generic message surface. */
import { DigestSchema, StoryValueSchema, TurnStorySchema, TurnViewSchema } from '@char-pub/core'
import { ReplayInputSchema, ReplayCommandSchema, LegacyReplayCommandSchema, TurnInputSchema, commandId } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { expandAssistantStream, ReasoningEffortId, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

/** Identifies one generation attempt within a roleplay Session. */
export type RequestId = Branded<'RoleplayRequestId'>
/**
 * Brand a nonempty request identifier.
 * @param value - Caller-assigned attempt ID.
 * @returns Validated request ID.
 */
export function RoleplayRequestId(value: string): RequestId {
  return brandString<RequestId>(z.string().min(1).parse(value))
}

/** Serialized resolved route; its fields map directly to the upstream LlmCallConfig. */
export const RoleplayCallConfigSchema = z.strictObject({
  provider: z.string().min(1), model: z.string().min(1),
  reasoningEffort: z.string().min(1).transform(ReasoningEffortId).optional(),
  temperature: z.number().optional(), maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
})
/** Resolved model route recorded before dispatch. */
export type RoleplayCallConfig = z.infer<typeof RoleplayCallConfigSchema>

/** Text-only SDK output retained alongside its original content source IDs. */
export const PreparedTextMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']), content: z.string(), source: z.array(z.string()),
})
/** Text transport snapshot, not a replacement SDK content schema. */
export type PreparedTextMessage = z.infer<typeof PreparedTextMessageSchema>
const StateSchema = TurnStorySchema.extend({ scene: z.string(), present: z.array(z.string()) })
const StreamSchema = z.custom<AssistantStreamRecord[]>((value) => {
  if (!Array.isArray(value)) return false
  try { expandAssistantStream(value) }
  catch (_error) { return false } // The upstream durable decoder owns compact-stream validation.
  return true
}, 'Invalid compact assistant stream').transform(value => structuredClone(value))
const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(), cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(), reasoningTokens: z.number().int().nonnegative().optional(),
})
const AssistantSchema = z.strictObject({ text: z.string().min(1), speaker: z.string().optional() })

/** The only event containing the complete fixed artifact and input snapshot. */
export const RoleplayOpenedSchema = z.strictObject({ version: z.literal(1), input: ReplayInputSchema, head: DigestSchema })
/** Proposed request: state changes remain uncommitted until success settlement. */
export const RoleplayRequestedSchema = z.strictObject({
  id: z.string().min(1).transform(RoleplayRequestId), parent_head: DigestSchema,
  command: LegacyReplayCommandSchema, config: RoleplayCallConfigSchema, proposed_config: RoleplayCallConfigSchema,
  messages: z.array(PreparedTextMessageSchema), plan_digest: DigestSchema,
  state_digest: DigestSchema, turn_digest: DigestSchema, request_digest: DigestSchema,
})
/** New player-turn narration contract, deliberately separate from legacy requested facts. */
export const RoleplayTurnRequestedSchema = RoleplayRequestedSchema.extend({ command: ReplayCommandSchema })
  .refine(value => value.command.operation.kind === 'turn', 'A turn request requires a turn command')
const SettlementFields = {
  id: z.string().min(1).transform(RoleplayRequestId), parent_head: DigestSchema, request_digest: DigestSchema,
  config: RoleplayCallConfigSchema, stream: StreamSchema, usage: UsageSchema.optional(),
}
/** Success carries the complete committed state; failure carries no fictional state transition. */
export const RoleplaySettledSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...SettlementFields, status: z.literal('success'), assistant: AssistantSchema,
    state: StateSchema, turn: TurnViewSchema, head: DigestSchema }),
  z.strictObject({ ...SettlementFields, status: z.literal('cancelled'), reason: z.string().min(1) }),
  z.strictObject({ ...SettlementFields, status: z.literal('failed'), reason: z.string().min(1) }),
])

/** Fixed initialization fact. */
export type RoleplayOpened = z.infer<typeof RoleplayOpenedSchema>
/** Exact generation input awaiting settlement. */
export type RoleplayRequested = z.infer<typeof RoleplayRequestedSchema>
/** Narration request carrying the new atomic turn operation and director evidence. */
export type RoleplayTurnRequested = z.infer<typeof RoleplayTurnRequestedSchema>
/** Either supported narration contract; the event name identifies the schema used on disk. */
export type RoleplayRequest = RoleplayRequested | RoleplayTurnRequested
/** Request outcome, including original compact stream evidence. */
export type RoleplaySettled = z.infer<typeof RoleplaySettledSchema>
/** Inputs accepted from the generation service at its settlement point. */
export type SettlementOutcome =
  | { status: 'success'; assistant: z.infer<typeof AssistantSchema>; stream: AssistantStreamRecord[]; usage?: z.infer<typeof UsageSchema> }
  | { status: 'cancelled' | 'failed'; reason: string; stream: AssistantStreamRecord[]; usage?: z.infer<typeof UsageSchema> }

/** One explicit player request, fenced by the last observed durable revision. */
export const PlayIntentSchema = z.strictObject({
  ...TurnInputSchema.shape, id: z.string().min(1).transform(commandId), expected_revision: DigestSchema,
  for_participant: z.string().min(1).optional(), recover_interrupted: z.literal(true).optional(),
  confirm_ending: z.strictObject({ proposal_id: DigestSchema }).optional(),
}).refine(value => value.text.trim().length > 0 || value.choice_id !== undefined, 'Supply text or an authored choice')
  .refine(value => !(value.confirm_ending && value.choice_id), 'Ending confirmation cannot also select a choice')
/** Both routes and the total decision allowance are explicit local configuration. */
export const PlayConfigSchema = z.strictObject({
  generation: RoleplayCallConfigSchema, decisions: RoleplayCallConfigSchema,
  limits: z.strictObject({
    min_confidence: z.number().gt(0.5).max(1), max_actions: z.number().int().positive(),
    max_decision_calls: z.number().int().positive(), max_decision_tokens: z.number().int().positive(),
  }),
})
/** Safe reason codes and state differences; callers must project these private facts for the player. */
export const TurnResolutionSchema = z.strictObject({
  committed: z.boolean(),
  actions: z.array(z.strictObject({ target: z.string(), status: z.enum(['applied', 'skipped', 'uncommitted']), reason: z.string() })),
  scene: z.strictObject({ before: z.string(), after: z.string() }),
  variables: z.array(z.strictObject({ name: z.string(), before: StoryValueSchema, after: StoryValueSchema })),
  knowledge: z.array(z.strictObject({ information: z.string(), learned_by: z.array(z.string()) })),
})
/** Durable intent before any decision model runs. */
export const RoleplayTurnStartedSchema = z.strictObject({
  intent: PlayIntentSchema, config: PlayConfigSchema, parent_head: DigestSchema, parent_revision: DigestSchema, digest: DigestSchema,
})
/** Actual decision messages and resolved route, written before dispatch. */
export const RoleplayDecisionRequestedSchema = z.strictObject({
  turn_id: z.string().min(1).transform(commandId), index: z.number().int().nonnegative(),
  stage: z.enum(['director', 'selector']), config: RoleplayCallConfigSchema, proposed_config: RoleplayCallConfigSchema,
  messages: z.array(PreparedTextMessageSchema), request_digest: DigestSchema,
})
const DecisionSettlementFields = {
  turn_id: z.string().min(1).transform(commandId), index: z.number().int().nonnegative(), request_digest: DigestSchema,
  stream: StreamSchema, usage: UsageSchema.optional(),
}
/** Complete decision outcome; reasoning stays private stream evidence and never enters resolution DTOs. */
export const RoleplayDecisionSettledSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...DecisionSettlementFields, status: z.literal('success'), text: z.string().min(1) }),
  z.strictObject({ ...DecisionSettlementFields, status: z.enum(['failed', 'cancelled']), reason: z.string().min(1) }),
])
/** Ends an unfinished planning phase without fabricating a narration request. */
export const RoleplayTurnAbortedSchema = z.strictObject({
  id: z.string().min(1).transform(commandId), parent_head: DigestSchema,
  status: z.enum(['failed', 'cancelled']), reason: z.string().min(1),
})
/** Append-only rewind of the current branch's most recent successful play. */
export const RoleplayRewoundSchema = z.strictObject({
  id: z.string().min(1).transform(commandId), turn_id: z.string().min(1).transform(commandId),
  parent_head: DigestSchema, parent_revision: DigestSchema, target_head: DigestSchema,
})
/** Validated player request with an explicit observed event revision. */
export type PlayIntent = z.infer<typeof PlayIntentSchema>
/** Fixed narration/decision routes and aggregate decision limits. */
export type PlayConfig = z.infer<typeof PlayConfigSchema>
/** Public app configuration for constrained planning and narration. */
export const RoleplayPlayConfigSchema = PlayConfigSchema
/** Application-facing alias for the bounded turn configuration. */
export type RoleplayPlayConfig = PlayConfig
/** Private settled action reasons and committed state differences. */
export type TurnResolution = z.infer<typeof TurnResolutionSchema>
/** Persisted player intent before the first decision request. */
export type RoleplayTurnStarted = z.infer<typeof RoleplayTurnStartedSchema>
/** Exact decision model input and route retained before dispatch. */
export type RoleplayDecisionRequested = z.infer<typeof RoleplayDecisionRequestedSchema>
/** Stored decision response or terminal failure, without Story effects. */
export type RoleplayDecisionSettled = z.infer<typeof RoleplayDecisionSettledSchema>
/** Terminal planning failure that publishes no new Story state. */
export type RoleplayTurnAborted = z.infer<typeof RoleplayTurnAbortedSchema>
/** Append-only restoration of a prior successful turn boundary. */
export type RoleplayRewound = z.infer<typeof RoleplayRewoundSchema>
/** Stable request outcome plus whether a later rewind removed it from the active branch. */
export interface PlayResult {
  settlement: RoleplaySettled | RoleplayTurnAborted
  resolution: TurnResolution
  superseded: boolean
  revision: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Initializes fixed Story input once. Required to interpret all later roleplay requests. */
    'roleplay/opened': RoleplayOpened
    /** Records exact prepared model messages without committing the proposed Story changes. */
    'roleplay/requested': RoleplayRequested
    /** Settles one request; only success publishes its complete post-state and assistant history. */
    'roleplay/settled': RoleplaySettled
    /** Stores player intent and decision limits before any planning request. */
    'roleplay/turn-started': RoleplayTurnStarted
    /** Retains atomic player-turn narration without widening the legacy requested contract. */
    'roleplay/turn-requested': RoleplayTurnRequested
    /** Stores the exact decision-provider input before dispatch. */
    'roleplay/decision-requested': RoleplayDecisionRequested
    /** Settles one decision attempt without committing Story state. */
    'roleplay/decision-settled': RoleplayDecisionSettled
    /** Ends planning without dispatching or committing a narration. */
    'roleplay/turn-aborted': RoleplayTurnAborted
    /** Restores the prior logical Story while retaining original attempts and idempotency records. */
    'roleplay/rewound': RoleplayRewound
  }
}
