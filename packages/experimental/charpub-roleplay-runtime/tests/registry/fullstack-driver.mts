/** Test-only JSONL bridge. OAuth credentials stay in this process; all imports consume built packages. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { commandId, type ReplayInput } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { createRegistryClient, createEndingProposals, createRuntimePreviewExports, createStoryContinuations, requestMessages } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime'
import { ExactRefSchema, TurnViewSchema } from '@char-pub/core'
import { createPreparationCatalog, fixedSelection, sourceRequests, startSession } from '@char-pub/assembler'
import { z } from 'zod'

type Client = Awaited<ReturnType<typeof createRegistryClient>>
type Proposals = ReturnType<typeof createEndingProposals>
type Candidate = Awaited<ReturnType<Proposals['prepare']>>
type PreviewExports = ReturnType<typeof createRuntimePreviewExports>
type PreviewReview = Awaited<ReturnType<PreviewExports['prepare']>>
type Continuations = ReturnType<typeof createStoryContinuations>
type ContinuationReview = Awaited<ReturnType<Continuations['prepare']>>
const Rights = z.union([z.strictObject({ inbound_equals_outbound: z.literal(true) }), z.strictObject({ explicit_grant: z.literal(true) })])
const Empty = z.strictObject({})
const ContentInput = z.strictObject({ release: ExactRefSchema, build_id: z.string().regex(/^dbld_[0-9a-z]{26}$/) })
const Command = z.discriminatedUnion('command', [
  z.strictObject({ id: z.number().int().positive(), command: z.literal('hello'), input: Empty }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('authorize'), input: z.strictObject({ registry_url: z.string().url(), issuer: z.string().url(), client_id: z.string().min(1) }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('exercise'), input: ContentInput }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('verify-revoked'), input: ContentInput }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('prepare-proposal'), input: z.strictObject({ release: ExactRefSchema, ending: z.unknown(), title: z.string().min(1), rights_ack: Rights }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('cancel-proposal'), input: z.strictObject({ candidate_digest: z.string() }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('submit-proposal'), input: z.strictObject({ candidate_digest: z.string(), rights_ack: Rights }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('prepare-preview-export'), input: z.strictObject({ history: TurnViewSchema.shape.history, bindings: TurnViewSchema.shape.bindings }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('confirm-preview-export'), input: z.strictObject({ candidate_digest: z.string() }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('prepare-continuation'), input: z.strictObject({ release: ExactRefSchema, namespace: z.string(), name: z.string(), display_name: z.string(), opening: z.string(), rights_ack: z.strictObject({ inbound_equals_outbound: z.literal(true) }) }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('submit-continuation'), input: z.strictObject({ candidate_digest: z.string(), rights_ack: z.strictObject({ inbound_equals_outbound: z.literal(true) }) }) }),
  z.strictObject({ id: z.number().int().positive(), command: z.literal('dispose'), input: Empty }),
])

const captures: GenerateOptions['messages'][] = []
class FixedAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    captures.push(structuredClone(options.messages))
    yield { type: 'text-delta', index: 0, text: 'The traveler follows the silver lantern.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const provider = {
  name: 'registry-fullstack-fixed-provider', inject: ['llm'],
  apply(ctx: Context) { ctx.llm.registerAdapter(['registry-fullstack-fixed'], new FixedAdapter()) },
}

async function loadRuntime(directory: string): Promise<Context> {
  const configuration = join(directory, 'cordis.yml')
  const packages = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime']
  for (const name of packages) assert.ok(import.meta.resolve(name).endsWith('/lib/index.js'), 'driver.compiled_import_required')
  await writeFile(configuration, JSON.stringify([
    { name: import.meta.resolve(packages[0] ?? '') },
    { name: import.meta.resolve(packages[1] ?? '') },
    { name: import.meta.resolve(packages[2] ?? ''), config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:registry-fullstack-fixed-provider' },
    { name: import.meta.resolve(packages[3] ?? ''), config: { timeout_ms: 10_000, max_event_bytes: 2_000_000, max_stream_bytes: 100_000 } },
  ]), { flag: 'wx', mode: 0o600 })
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['registry-fullstack-fixed-provider'] = provider
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } })
    await ctx.loader.await()
    assert.ok(ctx.get('roleplayRuntime'), 'driver.runtime_missing')
    assert.equal(ctx.get('agentLoop'), undefined)
    assert.equal(ctx.get('systemPrompt'), undefined)
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'charpub-registry-fullstack-'))
  await chmod(root, 0o700)
  let client: Client | undefined
  let runtime: Context | undefined
  let closed = false
  let callbackUsed = false
  let cookieSent = false
  let sourceReads = 0
  let contributionPosts = 0
  let derivationPosts = 0
  let continuations: Continuations | undefined
  let continuationReview: ContinuationReview | undefined
  const continuationSession = SessionId('registry-fullstack-continuation')
  let proposals: Proposals | undefined
  let candidate: Candidate | undefined
  let proposalRelease: z.infer<typeof ExactRefSchema> | undefined
  const proposalSession = SessionId('registry-fullstack-ending-proposal')
  const readSession = SessionId('registry-fullstack-story')
  let previewExports: PreviewExports | undefined
  let previewReview: PreviewReview | undefined
  let authorized: Promise<void> | undefined
  let complete: (() => void) | undefined
  let refuse: ((error: Error) => void) | undefined
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined
  const server = createServer((request, response) => {
    void (async () => {
      if (closed || !client || callbackUsed || request.method !== 'GET' || !request.url?.startsWith('/callback?')) {
        response.writeHead(410, { 'cache-control': 'no-store' }).end('This authorization request is no longer active.')
        return
      }
      callbackUsed = true
      try {
        await client.completeAuthorization(new URL(request.url, redirectURI).href)
        if (closed) throw new Error('driver.closed')
        complete?.()
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        response.end('<script>history.replaceState(null,"","/callback")</script><p>Authorization completed. Return to char.pub.</p>')
      } catch {
        refuse?.(new Error('driver.authorization_failed'))
        response.writeHead(400, { 'cache-control': 'no-store' }).end('Authorization could not be completed. Start again from char.pub.')
      } finally { if (authorizationTimer) clearTimeout(authorizationTimer) }
    })().catch(() => { response.destroy(); refuse?.(new Error('driver.callback_failed')) })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'driver.callback_address')
  const redirectURI = `http://127.0.0.1:${address.port}/callback`
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let cleanupTask: Promise<void> | undefined
  const cleanup = () => cleanupTask ??= (async () => {
    closed = true
    if (authorizationTimer) clearTimeout(authorizationTimer)
    refuse?.(new Error('driver.closed'))
    await client?.dispose()
    input.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    if (runtime) await runtime.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })()
  const terminate = () => { void cleanup().finally(() => process.exit(0)) }
  process.once('SIGTERM', terminate)
  process.once('SIGINT', terminate)
  const idle = setTimeout(terminate, 180_000)
  const checkedFetch: typeof fetch = async (url, options) => {
    const headers = new Headers(options?.headers)
    cookieSent ||= headers.has('cookie') || options?.credentials === 'include'
    assert.equal(cookieSent, false, 'driver.cookie_forwarding')
    const pathname = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname
    if (pathname.endsWith('/source-text')) sourceReads++
    if (pathname.endsWith('/contributions') && options?.method?.toUpperCase() === 'POST') {
      contributionPosts++
      assert.equal(typeof options.body, 'string', 'driver.proposal_body_required')
      const wire = z.record(z.string(), z.unknown()).parse(JSON.parse(String(options.body)))
      const allowed = ['title', 'description', 'base_revision', 'changes', 'changes_version', 'rights_ack', 'agent']
      assert.ok(Object.keys(wire).every(key => allowed.includes(key)), 'driver.proposal_private_fields')
      assert.ok(!String(options.body).includes('PRIVATE_HISTORY'), 'driver.history_in_request')
    }
    if (pathname.endsWith('/derivations') && options?.method?.toUpperCase() === 'POST') {
      derivationPosts++
      assert.equal(typeof options.body, 'string', 'driver.continuation_body_required')
      const wire = z.record(z.string(), z.unknown()).parse(JSON.parse(String(options.body)))
      assert.ok(Object.keys(wire).every(key => ['source', 'kind', 'name', 'display_name', 'from_play', 'agent', 'rights_ack'].includes(key)), 'driver.continuation_private_fields')
      const situation = z.record(z.string(), z.unknown()).parse(wire['from_play'])
      assert.deepEqual(Object.keys(situation).sort(), ['knowing', 'opening', 'present', 'scene', 'vars'])
      assert.ok(!String(options.body).includes('PRIVATE_HISTORY'), 'driver.history_in_continuation')
    }
    return fetch(url, options)
  }
  const needClient = () => { assert.ok(client, 'driver.not_configured'); return client }
  const denied = async (read: () => Promise<unknown>) => {
    try { await read(); return false } catch (error) {
      return error instanceof Error && /^registry\.(?:http_(?:401|403|404)|authorization_required|refresh_failed)$/.test(error.message)
    }
  }
  try {
    for await (const line of input) {
      if (closed) break
      if (Buffer.byteLength(line) > 1_000_000) throw new Error('driver.input_limit')
      const envelope = Command.safeParse(JSON.parse(line))
      if (!envelope.success) throw new Error('driver.invalid_command')
      const command = envelope.data
      try {
        let result: unknown
        switch (command.command) {
          case 'hello': result = { redirect_uri: redirectURI }; break
          case 'authorize': {
            if (client) throw new Error('driver.already_configured')
            client = await createRegistryClient({
              registryURL: command.input.registry_url, issuer: command.input.issuer, clientId: command.input.client_id, redirectURI,
              scopes: ['profile', 'creations:read', 'drafts:write', 'contributions:write', 'offline_access'],
              transport: { timeoutMs: 10_000, maxJSONBytes: 2_000_000, maxArtifactBytes: 8_000_000, allowLoopbackHTTP: true, fetch: checkedFetch },
            })
            authorized = new Promise<void>((done, reject) => { complete = done; refuse = reject })
            void authorized.catch(() => undefined)
            authorizationTimer = setTimeout(() => { refuse?.(new Error('driver.authorization_timeout')); callbackUsed = true }, 60_000)
            const started = await client.beginAuthorization()
            result = { authorization_url: started.authorizationURL }
            break
          }
          case 'exercise': {
            await authorized
            const registry = needClient()
            await registry.refreshAuthorization()
            const profile = await registry.profile()
            const released = await registry.release(command.input.release)
            assert.ok('release' in released.artifact.root, 'driver.release_identity')
            const loaded = await registry.draftBuild(command.input.build_id)
            const artifact = loaded.artifact
            assert.equal(artifact.kind, 'content')
            if (artifact.kind !== 'content') throw new Error('driver.content_required')
            assert.ok('origin' in artifact.root && artifact.root.origin.kind === 'draft-build', 'driver.draft_identity')
            const bindings: ReplayInput['bindings'] = {}
            for (const slot of artifact.ir.late_slots) bindings[slot.key] = { kind: slot.accepts.includes('persona') ? 'persona' : 'character', display_name: 'Guest' }
            const profileInput: ReplayInput['profile'] = { runtime: { name: 'registry-fullstack', version: '1' }, tokenizer: 'estimate', context_window: 8192, reserve_for_output: 512, mode: 'narrator', locale: 'en', capabilities: { system_role: true, multiple_system_messages: true } }
            const turn = startSession({ artifact, bindings, locale: 'en' }).turn
            const preparation = { artifact, profile: profileInput, turn }
            const source = artifact.catalog_index.sources[0]
            assert.ok(source, 'driver.source_missing')
            const selection = [{ source: source.id }]
            const plan = fixedSelection(createPreparationCatalog(preparation), selection)
            assert.equal(sourceRequests({ ...preparation, plan }).length, 1)
            const texts = await registry.sourceTexts(loaded, { ...preparation, plan })
            const text = texts[source.asset]
            assert.equal(typeof text, 'string')
            if (typeof text !== 'string') throw new Error('driver.source_missing')
            runtime = await loadRuntime(root)
            const id = readSession
            await runtime.roleplayRuntime.create(id, { artifact, profile: profileInput, bindings, locale: 'en', support: { supported: artifact.capabilities.map(capability => capability.id) }, source_texts: texts })
            const settled = await runtime.roleplayRuntime.submit(id, { id: commandId('ask-for-the-entrance'), operation: { kind: 'input', text: 'Where is the entrance?' }, selection }, { provider: 'registry-fullstack-fixed', model: 'fixed', maxTokens: 128 })
            assert.equal(settled.status, 'success')
            const projection = await runtime.roleplayRuntime.inspect(id)
            const request = [...projection.requests.values()][0]
            assert.ok(request, 'driver.request_missing')
            assert.equal(captures.length, 1)
            assert.deepEqual(captures[0], requestMessages(request))
            const response = projection.current.turn.history.at(-1)?.text
            assert.equal(response, 'The traveler follows the silver lantern.')
            await runtime.fiber.dispose()
            runtime = undefined
            // Keep committed JSONL, replace only this temporary Loader configuration for reopen.
            await rm(join(root, 'cordis.yml'))
            runtime = await loadRuntime(root)
            const restored = await runtime.roleplayRuntime.inspect(id)
            const restoredRequest = [...restored.requests.values()][0]
            assert.ok(restoredRequest, 'driver.restored_request_missing')
            assert.deepEqual(requestMessages(restoredRequest), captures[0])
            const sdk = import.meta.resolve('@char-pub/core')
            assert.ok(sdk.includes('/node_modules/') && !sdk.includes('/src/'), 'driver.packaged_sdk_required')
            result = {
              profile, sdk_import_is_packaged: true, runtime_import_is_compiled: true,
              release_id: released.artifact.root.release, build_id: command.input.build_id,
              source_count: Object.keys(texts).length,
              raw_source_digest: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
              messages: request.messages.map(message => ({ role: message.role, content: message.content })),
              logged_messages_equal: true, restored_messages_equal: true, response,
              source_request_count: sourceReads, credential_cookies_sent: cookieSent,
            }
            break
          }
          case 'prepare-preview-export': {
            assert.ok(runtime, 'driver.runtime_missing')
            const currentRuntime = runtime
            const before = await currentRuntime.roleplayRuntime.inspect(readSession)
            previewExports = createRuntimePreviewExports({ inspect: id => currentRuntime.roleplayRuntime.inspect(id) })
            previewReview = await previewExports.prepare({ session: readSession, history: command.input.history, bindings: command.input.bindings })
            const after = await currentRuntime.roleplayRuntime.inspect(readSession)
            assert.equal(after.head, before.head)
            assert.deepEqual(after.log, before.log)
            result = { digest: previewReview.digest, payload: previewReview.payload, session_unchanged: true }
            break
          }
          case 'confirm-preview-export': {
            assert.ok(runtime && previewExports && previewReview, 'driver.preview_review_missing')
            const before = await runtime.roleplayRuntime.inspect(readSession)
            const exported = await previewExports.export(previewReview, { candidate_digest: command.input.candidate_digest })
            const after = await runtime.roleplayRuntime.inspect(readSession)
            assert.equal(after.head, before.head)
            assert.deepEqual(after.log, before.log)
            assert.deepEqual(after.current, before.current)
            result = { json: exported.json, payload: exported.payload, session_unchanged: true }
            break
          }
          case 'prepare-proposal': {
            await authorized
            const registry = needClient()
            if (!runtime) {
              const loaded = await registry.release(command.input.release)
              const artifact = loaded.artifact
              if (artifact.kind !== 'content') throw new Error('driver.content_required')
              const bindings: ReplayInput['bindings'] = {}
              for (const slot of artifact.ir.late_slots) bindings[slot.key] = { kind: slot.accepts.includes('persona') ? 'persona' : 'character', display_name: 'Guest' }
              const profile: ReplayInput['profile'] = { runtime: { name: 'registry-proposal-fullstack', version: '1' }, tokenizer: 'estimate', context_window: 8192, reserve_for_output: 512, mode: 'narrator', locale: 'en', capabilities: { system_role: true, multiple_system_messages: true } }
              runtime = await loadRuntime(root)
              await runtime.roleplayRuntime.create(proposalSession, { artifact, profile, bindings, source_texts: {}, locale: 'en', support: { supported: artifact.capabilities.map(capability => capability.id) } })
              const settled = await runtime.roleplayRuntime.submit(proposalSession, { id: commandId('prepare-an-ending'), operation: { kind: 'input', text: 'PRIVATE_HISTORY: describe a possible end to the visit.' }, selection: [] }, { provider: 'registry-fullstack-fixed', model: 'fixed', maxTokens: 128 })
              assert.equal(settled.status, 'success')
              const projected = await runtime.roleplayRuntime.inspect(proposalSession)
              const logged = [...projected.requests.values()][0]
              assert.ok(logged, 'driver.request_missing')
              assert.deepEqual(captures[0], requestMessages(logged))
              proposalRelease = command.input.release
              const currentRuntime = runtime
              proposals = createEndingProposals({ registry, inspect: id => currentRuntime.roleplayRuntime.inspect(id) })
            }
            assert.deepEqual(proposalRelease, command.input.release, 'driver.proposal_release_changed')
            assert.ok(proposals, 'driver.proposals_missing')
            candidate = await proposals.prepare({ session: proposalSession, ending: command.input.ending, title: command.input.title, rights_ack: command.input.rights_ack })
            const review = { authorization_version: candidate.authorization_version, digest: candidate.digest, target: candidate.target, metadata: candidate.metadata, ending: candidate.ending, request: candidate.request }
            assert.ok(!JSON.stringify(review).includes('PRIVATE_HISTORY'), 'driver.history_in_proposal')
            assert.equal(contributionPosts, 0, 'driver.prepare_wrote_contribution')
            result = { candidate: review, contribution_posts: contributionPosts, session_settled: true, logged_messages_equal: true, credential_cookies_sent: cookieSent }
            break
          }
          case 'cancel-proposal': {
            assert.ok(proposals && candidate, 'driver.proposals_missing')
            assert.equal(command.input.candidate_digest, candidate.digest)
            const cancelled = new AbortController()
            cancelled.abort()
            const before = contributionPosts
            const reviewed = candidate
            const service = proposals
            await assert.rejects(() => service.submit(reviewed, { candidate_digest: reviewed.digest, rights_ack: reviewed.request.rights_ack }, cancelled.signal), { message: 'roleplay_proposal.cancelled' })
            assert.equal(contributionPosts, before)
            result = { cancelled: true, contribution_posts: contributionPosts }
            break
          }
          case 'submit-proposal': {
            assert.ok(proposals && candidate && runtime, 'driver.proposals_missing')
            const before = await runtime.roleplayRuntime.inspect(proposalSession)
            const receipt = await proposals.submit(candidate, { candidate_digest: command.input.candidate_digest, rights_ack: command.input.rights_ack })
            const after = await runtime.roleplayRuntime.inspect(proposalSession)
            assert.deepEqual(after.current, before.current, 'driver.proposal_mutated_session')
            assert.equal(after.head, before.head, 'driver.proposal_changed_head')
            assert.deepEqual(after.log, before.log, 'driver.proposal_changed_log')
            result = { receipt, contribution_posts: contributionPosts, session_unchanged: true, credential_cookies_sent: cookieSent }
            break
          }
          case 'prepare-continuation': {
            await authorized
            const registry = needClient()
            assert.equal(runtime, undefined, 'driver.continuation_runtime_exists')
            const loaded = await registry.release(command.input.release)
            const artifact = loaded.artifact
            if (artifact.kind !== 'content') throw new Error('driver.content_required')
            const bindings: ReplayInput['bindings'] = {}
            for (const slot of artifact.ir.late_slots) bindings[slot.key] = { kind: slot.accepts.includes('persona') ? 'persona' : 'character', display_name: 'Guest' }
            const profile: ReplayInput['profile'] = { runtime: { name: 'registry-continuation-fullstack', version: '1' }, tokenizer: 'estimate', context_window: 8192, reserve_for_output: 512, mode: 'narrator', locale: 'en', capabilities: { system_role: true, multiple_system_messages: true } }
            runtime = await loadRuntime(root)
            await runtime.roleplayRuntime.create(continuationSession, { artifact, profile, bindings, source_texts: {}, locale: 'en', support: { supported: artifact.capabilities.map(capability => capability.id) } })
            const call = { provider: 'registry-fullstack-fixed', model: 'fixed', maxTokens: 128 }
            const inputResult = await runtime.roleplayRuntime.submit(continuationSession, { id: commandId('continuation-input'), operation: { kind: 'input', text: 'PRIVATE_HISTORY: the travelers resolve their disagreement.' }, selection: [] }, call)
            assert.equal(inputResult.status, 'success')
            const beat = await runtime.roleplayRuntime.submit(continuationSession, { id: commandId('continuation-beat'), operation: { kind: 'confirm', target: 'beat/agreement' }, selection: [] }, call)
            assert.equal(beat.status, 'success')
            const present = await runtime.roleplayRuntime.submit(continuationSession, { id: commandId('continuation-presence'), operation: { kind: 'set-present', present: ['bob'] }, selection: [] }, call)
            assert.equal(present.status, 'success')
            const before = await runtime.roleplayRuntime.inspect(continuationSession)
            const logged = [...before.requests.values()]
            assert.equal(logged.length, captures.length)
            logged.forEach((request, index) => assert.deepEqual(captures[index], requestMessages(request)))
            const currentRuntime = runtime
            continuations = createStoryContinuations({ registry, inspect: id => currentRuntime.roleplayRuntime.inspect(id) })
            continuationReview = await continuations.prepare({ session: continuationSession, namespace: command.input.namespace, name: command.input.name, display_name: command.input.display_name, opening: command.input.opening, agent: true, rights_ack: command.input.rights_ack })
            const after = await runtime.roleplayRuntime.inspect(continuationSession)
            assert.deepEqual(after.current, before.current)
            assert.equal(after.head, before.head)
            assert.deepEqual(after.log, before.log)
            const { session: _session, ...review } = continuationReview
            assert.ok(!JSON.stringify(review).includes('PRIVATE_HISTORY'))
            assert.equal(derivationPosts, 0)
            result = { review, derivation_posts: derivationPosts, session_unchanged: true, logged_messages_equal: true, credential_cookies_sent: cookieSent }
            break
          }
          case 'submit-continuation': {
            assert.ok(continuations && continuationReview && runtime, 'driver.continuation_missing')
            const before = await runtime.roleplayRuntime.inspect(continuationSession)
            const receipt = await continuations.submit(continuationReview, { candidate_digest: command.input.candidate_digest, rights_ack: command.input.rights_ack })
            const after = await runtime.roleplayRuntime.inspect(continuationSession)
            assert.deepEqual(after.current, before.current)
            assert.equal(after.head, before.head)
            assert.deepEqual(after.log, before.log)
            result = { receipt, derivation_posts: derivationPosts, session_unchanged: true, credential_cookies_sent: cookieSent }
            break
          }
          case 'verify-revoked': {
            const registry = needClient()
            result = {
              profile_denied: await denied(() => registry.profile()),
              release_denied: await denied(() => registry.release(command.input.release)),
              build_denied: await denied(() => registry.draftBuild(command.input.build_id)),
              refresh_denied: await denied(() => registry.refreshAuthorization()),
              credential_cookies_sent: cookieSent,
            }
            break
          }
          case 'dispose': await cleanup(); result = { disposed: true }; break
        }
        process.stdout.write(`${JSON.stringify({ id: command.id, ok: true, result })}\n`)
      } catch (error) {
        const code = error instanceof Error && /^(registry|driver)\.[a-z0-9_.-]+$/.test(error.message) ? error.message : 'driver.operation_failed'
        process.stdout.write(`${JSON.stringify({ id: command.id, ok: false, code })}\n`)
      }
      if (command.command === 'dispose') break
    }
  } finally { clearTimeout(idle); await cleanup() }
}

// This executable is a bounded test bridge, never a supported Harness application launcher.
void main().catch(() => { process.stderr.write('driver.failed\n'); process.exitCode = 1 })
