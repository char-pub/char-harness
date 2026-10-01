/** Authenticated Registry consumption of immutable SDK artifacts; no credentials enter returned data. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CreationArtifactSchema, ExactRefSchema, RevisionIdSchema, canonicalizeCreation, digestOf, type CanonicalCreation, type CreationArtifact, type ExactRef } from '@char-pub/core'
import { sourceRequests } from '@char-pub/assembler'
import { ReleaseDetailSchema, ReleaseSourceSchema, DraftBuildResponseSchema, SourceTextResponseSchema, CreateCreationRequestSchema, CreateCreationResponseSchema, DeriveCreationRequestSchema, CreateContributionRequestSchema } from '@char-pub/contracts'
import { connectOAuth, type OAuthOptions } from './oauth.ts'
import { allowedURL, makeTransport } from './transport.ts'

/** HTTP and manually registered OAuth settings. Credentials stay in the returned instance. */
export type RegistryClientOptions = OAuthOptions
/** Verified artifact plus the Registry receipt that authorized its download. */
export interface LoadedContent {
  artifact: CreationArtifact
  receipt: z.infer<typeof ReleaseDetailSchema> | z.infer<typeof DraftBuildResponseSchema>
}
/** A caller must obtain explicit user confirmation for each write; this flag is not server authorization. */
export interface ConfirmedWrite {
  confirmed: boolean
  /** Bind a previously reviewed operation to this authenticated client grant. */
  expectedAuthorizationVersion?: number
}

/** In-memory public-client authorization and exact Registry reads; never a publication API. */
export interface RegistryClient {
  /** Local grant epoch; new grants, revocation or credential loss invalidate earlier reviews. Refresh preserves it. */
  authorizationVersion(): number
  /** Open one pending authorization request; a new request replaces pending state. */
  beginAuthorization(): Promise<{ authorizationURL: string }>
  /** Validate and consume the exact browser callback before exchanging its code. */
  completeAuthorization(callbackURL: string): Promise<void>
  /** Rotate once, sharing any in-flight rotation; uncertain outcomes clear authorization. */
  refreshAuthorization(): Promise<void>
  /** Revoke the current refresh family, or current access token without offline access. */
  revoke(): Promise<void>
  /** Forget credentials locally; this does not promise remote revocation. */
  dispose(): Promise<void>
  /** Read only the public account ID and namespace authorized by profile scope. */
  profile(): Promise<{ id: string; namespace: string | null }>
  /** Read one exact Release; the original artifact identity remains authoritative after rename. */
  release(exact: ExactRef, signal?: AbortSignal): Promise<LoadedContent>
  /** Read the immutable author definition and Revision after verifying its exact published artifact. No latest fallback. */
  releaseSource(exact: ExactRef, signal?: AbortSignal): Promise<{
    release: LoadedContent
    source: Omit<z.infer<typeof ReleaseSourceSchema>, 'creation'> & { creation: CanonicalCreation }
  }>
  /** Read one Registry-issued draft receipt without creating or rebuilding it. */
  receipt(buildID: string, signal?: AbortSignal): Promise<z.infer<typeof DraftBuildResponseSchema>>
  /** Download a ready unexpired draft artifact and verify its receipt. */
  draftBuild(buildID: string, signal?: AbortSignal): Promise<LoadedContent>
  /** Fetch only SDK-requested bodies for this acquired artifact and exact preparation Plan. */
  sourceTexts(value: LoadedContent, input: Parameters<typeof sourceRequests>[0], signal?: AbortSignal): Promise<Record<string, string>>
  /** Create a new working draft once after the caller obtains confirmation. */
  createWorkingDraft(
    namespace: string, input: z.input<typeof CreateCreationRequestSchema>, confirmation: ConfirmedWrite,
  ): Promise<z.infer<typeof CreateCreationResponseSchema>>
  /** Ask the Registry to prepare a new exact-source Remix or sequel after confirmation. */
  derive(
    namespace: string, input: z.input<typeof DeriveCreationRequestSchema>, confirmation: ConfirmedWrite, signal?: AbortSignal,
  ): Promise<z.infer<typeof CreateCreationResponseSchema>>
  /** Submit a proposal for review after confirmation; never accept or publish it. */
  contribute(ref: string, input: z.input<typeof CreateContributionRequestSchema>, confirmation: ConfirmedWrite, signal?: AbortSignal): Promise<{ id: string; number: number; status: 'open'; agent: boolean; sensitive_keys: string[] }>
}

/**
 * Discover the Registry OAuth server and create an isolated in-memory client.
 * @param options - Exact issuer, registered client/redirect, scopes and HTTP limits.
 * @returns A client with explicit authorization, verified reads and confirmed draft/contribution writes.
 */
export async function createRegistryClient(options: RegistryClientOptions): Promise<RegistryClient> {
  const auth = await connectOAuth(options)
  const send = makeTransport(options.transport)
  const base = allowedURL(options.registryURL, options.transport.allowLoopbackHTTP === true)
  if (base.pathname !== '/' || base.search) throw new Error('registry.origin_required')
  const artifactIdentity = (value: CreationArtifact) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const loaded = new WeakMap<LoadedContent, { artifactDigest: string; path: string; expires?: number }>()
  function checkAbort(signal?: AbortSignal | null) {
    if (signal?.aborted) throw new Error('registry.request_aborted')
  }
  async function request(path: string, init: RequestInit = {}, limit = options.transport.maxJSONBytes, expectedVersion?: number) {
    checkAbort(init.signal)
    if (expectedVersion !== undefined && auth.authorizationVersion() !== expectedVersion) throw new Error('registry.authorization_changed')
    const token = await auth.access()
    checkAbort(init.signal)
    if (expectedVersion !== undefined && (auth.authorizationVersion() !== expectedVersion || !token))
      throw new Error('registry.authorization_changed')
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    const response = await send(new URL(path, base), { ...init, headers }, limit)
    if (response.status === 401) auth.invalidate()
    return response
  }
  async function json(path: string, init?: RequestInit, expectedVersion?: number): Promise<unknown> {
    const response = await request(path, init, options.transport.maxJSONBytes, expectedVersion)
    if (!response.ok) throw new Error(`registry.http_${response.status}`)
    return response.json()
  }
  async function artifact(path: string, expected: string, signal?: AbortSignal): Promise<CreationArtifact> {
    let currentURL = new URL(path, base)
    let response = await request(path, signal ? { signal } : {}, options.transport.maxArtifactBytes)
    // Signed object requests have no credentials, including redirects back to the Registry.
    for (let hop = 0; [301, 302, 303, 307, 308].includes(response.status); hop++) {
      if (hop >= 3) throw new Error('registry.redirect_limit')
      const location = response.headers.get('location')
      if (!location) throw new Error('registry.redirect_missing')
      const url = allowedURL(new URL(location, currentURL), options.transport.allowLoopbackHTTP === true)
      currentURL = url
      response = await send(url, signal ? { signal } : {}, options.transport.maxArtifactBytes)
    }
    if (!response.ok) throw new Error(`registry.http_${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > options.transport.maxArtifactBytes) throw new Error('registry.response_too_large')
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected) throw new Error('registry.artifact_digest_mismatch')
    return CreationArtifactSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  }
  function remember(value: LoadedContent, path: string, expires?: number) {
    loaded.set(value, { artifactDigest: artifactIdentity(value.artifact), path, ...(expires === undefined ? {} : { expires }) })
    return value
  }
  function checkLoaded(value: LoadedContent) {
    const known = loaded.get(value)
    if (!known || artifactIdentity(value.artifact) !== known.artifactDigest) throw new Error('registry.unverified_artifact')
    if (known.expires !== undefined && Date.now() >= known.expires) throw new Error('registry.draft_expired')
    return known
  }
  async function write(path: string, body: unknown, confirmation: ConfirmedWrite, signal?: AbortSignal) {
    if (!confirmation.confirmed) throw new Error('registry.confirmation_required')
    // Mutations are never retried, including uncertain network outcomes.
    return json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }, confirmation.expectedAuthorizationVersion)
  }
  async function receipt(buildID: string, signal?: AbortSignal) {
    checkAbort(signal)
    if (!/^dbld_[0-9a-z]{26}$/.test(buildID)) throw new Error('registry.invalid_build_id')
    const receipt = DraftBuildResponseSchema.parse(await json(`/v1/draft-builds/${buildID}`, signal ? { signal } : undefined))
    if (receipt.origin.build_id !== buildID) throw new Error('registry.build_mismatch')
    return receipt
  }
  async function release(exact: ExactRef, signal?: AbortSignal) {
    const pin = ExactRefSchema.parse(exact)
    const path = `/v1/releases/${encodeURIComponent(pin.release)}`
    const receipt = ReleaseDetailSchema.parse(await json(path, signal ? { signal } : undefined))
    if (receipt.id !== pin.release || receipt.semantic_digest !== pin.semantic_digest || receipt.status !== 'active') throw new Error('registry.release_mismatch')
    if (!receipt.artifact_digest) throw new Error('registry.artifact_unsupported')
    const value = await artifact(`${path}/artifact`, receipt.artifact_digest, signal)
    if (!('release' in value.root) || value.root.release !== pin.release || value.root.ref !== pin.ref || value.root.semantic_digest !== pin.semantic_digest) throw new Error('registry.release_mismatch')
    checkAbort(signal)
    return { artifact: value, receipt }
  }
  return {
    authorizationVersion: () => auth.authorizationVersion(),
    beginAuthorization: () => auth.beginAuthorization(),
    completeAuthorization: (callbackURL: string) => auth.completeAuthorization(callbackURL),
    refreshAuthorization: () => auth.refreshAuthorization(),
    revoke: () => auth.revoke(),
    dispose: async () => { await Promise.all([auth.dispose(), send.dispose()]) },
    async profile() { return z.strictObject({ id: z.string(), namespace: z.string().nullable() }).parse(await json('/v1/profile')) },
    async release(exact: ExactRef, signal?: AbortSignal) {
      const value = await release(exact, signal)
      return remember(value, `/v1/releases/${encodeURIComponent(value.receipt.id)}`)
    },
    async releaseSource(exact: ExactRef, signal?: AbortSignal) {
      checkAbort(signal)
      const value = await release(exact, signal)
      const { receipt, artifact: verified } = value
      // The receipt names the current address; the immutable source keeps its original ref after rename.
      const match = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(receipt.ref)
      if (!match) throw new Error('registry.invalid_ref')
      const path = `/v1/creations/@${match[1]}/${match[2]}/releases/${encodeURIComponent(receipt.label)}/source`
      const source = ReleaseSourceSchema.parse(await json(path, signal ? { signal } : undefined))
      checkAbort(signal)
      const canonical = canonicalizeCreation(source.creation)
      if (!RevisionIdSchema.safeParse(source.revision).success
        || source.semantic_digest !== verified.root.semantic_digest
        || canonical.semantic_digest !== verified.root.semantic_digest
        || canonical.creation.ref !== verified.root.ref
        || canonical.creation.id !== receipt.creation) throw new Error('registry.source_mismatch')
      return {
        release: remember(value, `/v1/releases/${encodeURIComponent(receipt.id)}`),
        source: { ...source, creation: canonical.creation },
      }
    },
    receipt,
    async draftBuild(buildID: string, signal?: AbortSignal): Promise<LoadedContent> {
      const receiptValue = await receipt(buildID, signal)
      const expires = Date.parse(receiptValue.origin.expires_at)
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('registry.draft_expired')
      if (receiptValue.state !== 'ready' || !receiptValue.artifact_digest) throw new Error(`registry.draft_${receiptValue.state}`)
      const path = `/v1/draft-builds/${buildID}`
      const value = await artifact(`${path}/artifact`, receiptValue.artifact_digest, signal)
      if (!('origin' in value.root) || value.root.origin.kind !== 'draft-build' || digestOf(value.root.origin) !== digestOf(receiptValue.origin) || value.root.semantic_digest !== receiptValue.semantic_digest || value.lock_digest !== receiptValue.lock_digest) throw new Error('registry.build_mismatch')
      checkAbort(signal)
      if (Date.now() >= expires) throw new Error('registry.draft_expired')
      return remember({ artifact: value, receipt: receiptValue }, path, expires)
    },
    async sourceTexts(
      value: LoadedContent, input: Parameters<typeof sourceRequests>[0], signal?: AbortSignal,
    ): Promise<Record<string, string>> {
      checkAbort(signal)
      const known = checkLoaded(value)
      if (artifactIdentity(input.artifact) !== known.artifactDigest) throw new Error('registry.preparation_mismatch')
      const result: Record<string, string> = {}
      for (const source of sourceRequests(input)) {
        checkLoaded(value)
        const body = SourceTextResponseSchema.parse(await json(`${known.path}/source-text?source=${encodeURIComponent(source.source)}`, signal ? { signal } : undefined))
        if (body.source !== source.source || body.asset !== source.asset || body.digest !== source.digest || `sha256:${createHash('sha256').update(body.text, 'utf8').digest('hex')}` !== source.digest) throw new Error('registry.source_mismatch')
        result[source.asset] = body.text
      }
      checkAbort(signal)
      checkLoaded(value)
      return result
    },
    async createWorkingDraft(namespace: string, input: z.input<typeof CreateCreationRequestSchema>, confirmation: ConfirmedWrite) {
      return CreateCreationResponseSchema.parse(await write(`/v1/namespaces/${encodeURIComponent(namespace)}/creations`, CreateCreationRequestSchema.parse(input), confirmation))
    },
    async derive(
      namespace: string, input: z.input<typeof DeriveCreationRequestSchema>, confirmation: ConfirmedWrite, signal?: AbortSignal,
    ) {
      return CreateCreationResponseSchema.parse(await write(`/v1/namespaces/${encodeURIComponent(namespace)}/derivations`, DeriveCreationRequestSchema.parse(input), confirmation, signal))
    },
    async contribute(
      ref: string, input: z.input<typeof CreateContributionRequestSchema>, confirmation: ConfirmedWrite, signal?: AbortSignal,
    ) {
      const match = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(ref)
      if (!match) throw new Error('registry.invalid_ref')
      return z.strictObject({ id: z.string(), number: z.number().int().positive(), status: z.literal('open'), agent: z.boolean(), sensitive_keys: z.array(z.string()) }).parse(await write(`/v1/creations/@${match[1]}/${match[2]}/contributions`, CreateContributionRequestSchema.parse(input), confirmation, signal))
    },
  }
}
