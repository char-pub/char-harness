/** Replay evidence for sanitized decision-provider requests; transport credentials are never fields. */
import { DigestSchema, SelectionPlanSchema, TurnViewSchema, digestExactJSON } from '@char-pub/core'
import { z } from 'zod'
import { ActionAssessmentSchema, StoryActionSchema, TurnEndingProposalSchema } from './turn.ts'

const fields = {
  provider: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  config: z.record(z.string(), z.json()),
  input: SelectionPlanSchema.shape.input,
  request: z.json(),
  response: z.json(),
}
const variants = [
  z.strictObject({ ...fields, purpose: z.literal('selector'), binding: z.strictObject({ plan_digest: DigestSchema }) }),
  z.strictObject({ ...fields, purpose: z.literal('judge'), binding: z.strictObject({ judgments: TurnViewSchema.shape.judgments.unwrap().min(1) }) }),
  z.strictObject({ ...fields, purpose: z.literal('director'), binding: z.strictObject({
    actions: z.array(StoryActionSchema), assessments: z.array(ActionAssessmentSchema),
    judgments: TurnViewSchema.shape.judgments.unwrap(), ending_proposal: TurnEndingProposalSchema.optional(),
  }) }),
] as const
const PayloadSchema = z.discriminatedUnion('purpose', variants)
const transportKeys = new Set([
  'headers', 'authorization', 'cookie', 'setcookie', 'apikey', 'accesstoken', 'refreshtoken',
  'password', 'secret', 'baseurl', 'endpoint',
])

/** Input to the evidence constructor; request/response may contain complete round arrays. */
type InputBodies<T> = T extends object ? Omit<T, 'request' | 'response'> & { request: unknown; response: unknown } : never
/** Decision evidence before JSON validation and digest assignment. */
export type DecisionRecordInput = InputBodies<z.infer<typeof PayloadSchema>>

/** Validates JSON evidence, its hash, and omission of credential/transport configuration fields. */
const RecordSchema = z.discriminatedUnion('purpose', [
  variants[0].extend({ digest: DigestSchema }),
  variants[1].extend({ digest: DigestSchema }),
  variants[2].extend({ digest: DigestSchema }),
])
function checkRecord(record: z.infer<typeof RecordSchema>, ctx: z.RefinementCtx) {
  const pending: { value: z.infer<ReturnType<typeof z.json>>; path: (string | number)[] }[] = [
    { value: record.config, path: ['config'] }, { value: record.request, path: ['request'] },
    { value: record.response, path: ['response'] },
  ]
  while (pending.length) {
    const next = pending.pop()
    if (!next || next.value === null || typeof next.value !== 'object') continue
    for (const [key, value] of Object.entries(next.value)) {
      const path = [...next.path, key]
      if (transportKeys.has(key.replace(/[-_]/g, '').toLowerCase()))
        ctx.addIssue({ code: 'custom', path, message: 'Transport or credential fields cannot be recorded' })
      pending.push({ value, path })
    }
  }
  const { digest, ...payload } = record
  if (digestExactJSON(payload) !== digest) ctx.addIssue({ code: 'custom', path: ['digest'], message: 'Decision evidence digest mismatch' })
}

/** Validated evidence for the original selector/judge event contract. */
export const LegacyDecisionRecordSchema = z.discriminatedUnion('purpose', [
  variants[0].extend({ digest: DigestSchema }), variants[1].extend({ digest: DigestSchema }),
]).superRefine(checkRecord)
/** Validates complete director, selector and judge evidence. */
export const DecisionRecordSchema = RecordSchema.superRefine(checkRecord)

/** Hashed sanitized provider input/output and the decision it produced. */
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>

/**
 * Construct detached evidence without HTTP headers, endpoint URLs or credentials.
 * @param value - Exact sanitized request/response bodies, public config and decision binding.
 * @returns Hash-linked evidence; forbidden transport fields or invalid JSON throw. Text is not scrubbed for user-authored secrets.
 */
export function makeDecisionRecord(value: DecisionRecordInput): DecisionRecord {
  const payload = PayloadSchema.parse(value)
  return DecisionRecordSchema.parse({ ...payload, digest: digestExactJSON(payload) })
}
