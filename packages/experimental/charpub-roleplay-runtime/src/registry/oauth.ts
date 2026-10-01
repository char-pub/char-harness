/** Public OAuth client; credentials and PKCE state remain in this instance's private memory. */
import * as oauth from 'oauth4webapi'
import { allowedURL, makeTransport, type TransportOptions } from './transport.ts'

/** Exact manually registered client settings for one Registry origin. */
export interface OAuthOptions {
  registryURL: string
  issuer: string
  clientId: string
  redirectURI: string
  scopes: string[]
  transport: TransportOptions
}

interface OAuthSession {
  authorizationVersion(): number
  authorizationStatus(): 'required' | 'authorized'
  beginAuthorization(): Promise<{ authorizationURL: string }>
  completeAuthorization(callbackURL: string): Promise<void>
  access(): Promise<string | undefined>
  refreshAuthorization(): Promise<void>
  invalidate(): void
  revoke(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Bind library OAuth operations to one issuer and isolated credential memory.
 * @param options - Registry origin, registration and bounded HTTP settings.
 * @returns Private authorization operations for the Registry consumer.
 */
export async function connectOAuth(options: OAuthOptions): Promise<OAuthSession> {
  const send = makeTransport(options.transport)
  const origin = allowedURL(options.registryURL, options.transport.allowLoopbackHTTP === true).origin
  const issuer = allowedURL(options.issuer, options.transport.allowLoopbackHTTP === true)
  const redirect = allowedURL(options.redirectURI, options.transport.allowLoopbackHTTP === true)
  if (issuer.origin !== origin || !options.clientId) throw new Error('registry.invalid_oauth_config')
  const responseFields = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss']
  if (responseFields.some(key => redirect.searchParams.has(key))) throw new Error('registry.invalid_redirect_query')
  const allowed = ['profile', 'creations:read', 'drafts:write', 'contributions:write', 'offline_access']
  if (!options.scopes.length || options.scopes.some(scope => !allowed.includes(scope))) throw new Error('registry.invalid_scope')
  const customFetch = async (input: string, init: oauth.CustomFetchOptions<string, BodyInit | undefined>) => {
    const url = new URL(input)
    if (url.origin !== origin) throw new Error('registry.oauth_endpoint_origin')
    return send(url, {
      method: init.method, headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal ? { signal: init.signal } : {}),
    })
  }
  // OAuth library requires this opt-in for an explicitly allowed local development Registry.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const insecure = options.transport.allowLoopbackHTTP ? { [oauth.allowInsecureRequests]: true } : {}
  const protocol = { [oauth.customFetch]: customFetch, ...insecure }
  const discovery = await oauth.discoveryRequest(issuer, { ...protocol, algorithm: 'oauth2' })
  const server = await oauth.processDiscoveryResponse(issuer, discovery)
  for (const endpoint of [server.authorization_endpoint, server.token_endpoint, server.revocation_endpoint]) {
    if (!endpoint || allowedURL(endpoint, options.transport.allowLoopbackHTTP === true).origin !== origin) throw new Error('registry.oauth_endpoint_origin')
  }
  if (!server.code_challenge_methods_supported?.includes('S256') || !server.token_endpoint_auth_methods_supported?.includes('none')) throw new Error('registry.oauth_unsupported')
  const client = { client_id: options.clientId, token_endpoint_auth_method: 'none' }
  let pending: { state: string; verifier: string; expires: number } | undefined
  let tokens: { access: string; refresh?: string; expires: number } | undefined
  let operation: Promise<unknown> = Promise.resolve()
  let refreshing: Promise<string> | undefined
  let closed = false
  let generation = 0
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = operation.then(fn)
    operation = result.catch(() => undefined)
    return result
  }
  function accept(result: oauth.TokenEndpointResponse, expectedGeneration: number) {
    if (closed || generation !== expectedGeneration) throw new Error('registry.authorization_changed')
    if (result.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || !result.expires_in || result.expires_in <= 0 || (result.scope && result.scope.split(' ').some(scope => !options.scopes.includes(scope)))) throw new Error('registry.invalid_token_response')
    tokens = {
      access: result.access_token,
      ...(result.refresh_token ? { refresh: result.refresh_token } : {}),
      expires: Date.now() + result.expires_in * 1000,
    }
  }
  function refresh(): Promise<string> {
    refreshing ??= exclusive(async () => {
      if (!tokens?.refresh || closed) throw new Error('registry.authorization_required')
      const expectedGeneration = generation
      try {
        const response = await oauth.refreshTokenGrantRequest(server, client, oauth.None(), tokens.refresh, protocol)
        const result = await oauth.processRefreshTokenResponse(server, client, response)
        if (!result.refresh_token) throw new Error('registry.refresh_rotation_missing')
        accept(result, expectedGeneration)
        return result.access_token
      } catch {
        if (generation === expectedGeneration) { generation++; tokens = undefined }
        throw new Error('registry.refresh_failed')
      }
    }).finally(() => { refreshing = undefined })
    return refreshing
  }
  return {
    authorizationVersion: () => generation,
    authorizationStatus: () => !closed && tokens && (tokens.expires > Date.now() || tokens.refresh) ? 'authorized' : 'required',
    beginAuthorization() {
      return exclusive(async () => {
        if (closed) throw new Error('registry.disposed')
        generation++
        tokens = undefined
        const verifier = oauth.generateRandomCodeVerifier()
        const state = oauth.generateRandomState()
        pending = { verifier, state, expires: Date.now() + 10 * 60 * 1000 }
        const url = new URL(server.authorization_endpoint ?? '')
        url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect.href, response_type: 'code', scope: options.scopes.join(' '), state, code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' }).toString()
        return { authorizationURL: url.href }
      })
    },
    completeAuthorization(callbackURL: string) {
      return exclusive(async () => {
        const current = pending
        if (closed || !current || current.expires <= Date.now()) throw new Error('registry.authorization_expired')
        const callback = allowedURL(callbackURL, options.transport.allowLoopbackHTTP === true)
        const staticQuery = new URLSearchParams(callback.search)
        for (const field of responseFields) staticQuery.delete(field)
        const expectedQuery = new URLSearchParams(redirect.search)
        staticQuery.sort(); expectedQuery.sort()
        if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || staticQuery.toString() !== expectedQuery.toString()) throw new Error('registry.redirect_mismatch')
        try {
          const parameters = oauth.validateAuthResponse(server, client, callback, current.state)
          pending = undefined
          const expectedGeneration = generation
          const response = await oauth.authorizationCodeGrantRequest(
            server, client, oauth.None(), parameters, redirect.href, current.verifier, protocol,
          )
          accept(await oauth.processAuthorizationCodeResponse(server, client, response), expectedGeneration)
          generation++
        } catch { throw new Error('registry.authorization_failed') }
      })
    },
    async access(): Promise<string | undefined> {
      if (closed) throw new Error('registry.disposed')
      if (refreshing) return refreshing
      if (!tokens) return undefined
      if (tokens.expires > Date.now()) return tokens.access
      if (!tokens.refresh) { generation++; tokens = undefined; throw new Error('registry.authorization_required') }
      return refresh()
    },
    async refreshAuthorization() { await refresh() },
    invalidate() { generation++; tokens = undefined },
    revoke() {
      return exclusive(async () => {
        pending = undefined
        const prior = tokens
        generation++
        tokens = undefined
        if (!prior) return
        try {
          const response = await oauth.revocationRequest(server, client, oauth.None(), prior.refresh ?? prior.access, protocol)
          await oauth.processRevocationResponse(response)
        }
        catch { throw new Error('registry.revocation_failed') }
      })
    },
    async dispose() {
      closed = true; generation++; pending = undefined; tokens = undefined
      await send.dispose()
      await operation
    },
  }
}
