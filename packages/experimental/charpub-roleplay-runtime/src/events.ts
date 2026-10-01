/** Required roleplay Session facts; these events never join the generic message surface. */
import { DigestSchema, TurnStorySchema, TurnViewSchema } from '@char-pub/core'
import { ReplayInputSchema, ReplayCommandSchema } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
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
  command: ReplayCommandSchema, config: RoleplayCallConfigSchema, proposed_config: RoleplayCallConfigSchema,
  messages: z.array(PreparedTextMessageSchema), plan_digest: DigestSchema,
  state_digest: DigestSchema, turn_digest: DigestSchema, request_digest: DigestSchema,
})
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
/** Request outcome, including original compact stream evidence. */
export type RoleplaySettled = z.infer<typeof RoleplaySettledSchema>
/** Inputs accepted from the generation service at its settlement point. */
export type SettlementOutcome =
  | { status: 'success'; assistant: z.infer<typeof AssistantSchema>; stream: AssistantStreamRecord[]; usage?: z.infer<typeof UsageSchema> }
  | { status: 'cancelled' | 'failed'; reason: string; stream: AssistantStreamRecord[]; usage?: z.infer<typeof UsageSchema> }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Initializes fixed Story input once. Required to interpret all later roleplay requests. */
    'roleplay/opened': RoleplayOpened
    /** Records exact prepared model messages without committing the proposed Story changes. */
    'roleplay/requested': RoleplayRequested
    /** Settles one request; only success publishes its complete post-state and assistant history. */
    'roleplay/settled': RoleplaySettled
  }
}
