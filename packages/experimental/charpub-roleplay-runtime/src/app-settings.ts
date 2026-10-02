/** Settings operations for the roleplay app over the Harness settings, credential, LLM directory and Loader services. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { z } from 'zod'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import type {
  AppCredentialState, AppModelProvider, AppModelsView, AppPluginConfigView, AppPluginsView,
} from './app-types.ts'

/** Settings pages shown by the roleplay app; namespaces owned by a dedicated page are excluded from the plugin forms. */
export interface AppSettingsOptions {
  /** Credential reference the configured model adapter resolves. */
  credentialRef: string
  /** Entry id of this app; its own HTTP limits are not offered as a live form. */
  appEntryId: string
  /** Provider route the app generates with; its key is the one the status banner reports. */
  provider: string
}

const PathOp = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set'), path: z.array(z.string().min(1)).max(8), value: z.json() }),
  z.strictObject({ op: z.literal('unset'), path: z.array(z.string().min(1)).max(8) }),
])
const Write = z.strictObject({
  ns: z.string().min(1).max(200),
  ops: z.array(PathOp).max(64),
  revision: z.number().int().min(0).optional(),
})
const ModelsWrite = Write.extend({ api_key: z.string().trim().min(1).max(4096).optional() })
const Namespace = z.strictObject({ ns: z.string().min(1).max(200) })

function fail(code: string): never { throw new Error(`roleplay_app.${code}`) }

/** JSON operations behind the same-origin settings routes; every input is validated here. */
export interface AppSettings {
  /** @returns Configurable model providers with their live form and credential state. */
  models(): Promise<AppModelsView>
  /**
   * Apply one provider card: settings path edits first, then an optional new key; a refused write stores no key.
   * @param raw - Namespace, path ops, read revision and optional API key.
   * @returns The refreshed providers.
   */
  saveModel(raw: unknown): Promise<AppModelsView>
  /**
   * Remove the stored key of one provider; a read-only launching-environment value is refused and stays in effect.
   * @param raw - Provider namespace.
   * @returns The refreshed providers.
   */
  clearModelKey(raw: unknown): Promise<AppModelsView>
  /** @returns Current Loader entries with display metadata and where each is configured. */
  plugins(): Promise<AppPluginsView>
  /**
   * Read one plugin's live form; the app entry itself is not offered.
   * @param raw - Settings namespace (profile entry id).
   * @returns The redacted live configuration form.
   */
  pluginConfig(raw: unknown): AppPluginConfigView
  /**
   * Apply path edits to one plugin form; Models namespaces are written only through {@link saveModel}.
   * @param raw - Namespace, ordered path ops and the read revision.
   * @returns The form after the write.
   */
  savePluginConfig(raw: unknown): Promise<AppPluginConfigView>
  /** @returns Presence of the key the app's generation provider resolves. */
  credential(): Promise<AppCredentialState>
}

/**
 * Create the app's settings operations. Every write goes through the optional `settings` service (profile
 * `cordis.patch.yml`) or `ctx.credentials`; no operation returns a stored secret.
 * @param ctx - App plugin context with credentials, llm and loader services.
 * @param options - Configured credential reference and this app's entry id.
 * @returns JSON operations for the same-origin settings routes.
 */
export function createAppSettings(ctx: Context, options: AppSettingsOptions): AppSettings {
  if (!isCredentialRefName(options.credentialRef)) fail('credential_ref_invalid')
  const fallbackRef = credentialRef(options.credentialRef)

  async function credential(ref = fallbackRef): Promise<AppCredentialState> {
    const info = await ctx.credentials.describe(ref)
    return { configured: info.configured, ...(info.source === undefined ? {} : { source: info.source }), writable: info.writable }
  }
  // The settings service exists only in a launcher-owned profile; without it forms are absent and keys stay writable.
  function descriptors(): SettingsDescriptor[] {
    return ctx.get('settings')?.describe({ redactSecrets: true }) ?? []
  }
  function refOf(descriptor: SettingsDescriptor | undefined, path: readonly string[]) {
    let value: unknown = descriptor?.value
    for (const key of path) value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
    const named = typeof value === 'object' && value !== null ? (value as { apiKeyEnv?: unknown }).apiKeyEnv : undefined
    return typeof named === 'string' && isCredentialRefName(named) ? credentialRef(named) : fallbackRef
  }
  type ProviderRow = { entry: ReturnType<typeof ctx.llm.listConfigurableProviders>[number]; descriptor: SettingsDescriptor | undefined }
  function providers(): ProviderRow[] {
    const all = descriptors()
    return ctx.llm.listConfigurableProviders().map(entry => ({ entry, descriptor: all.find(row => row.ns === entry.settingsNs) }))
  }
  /** Entries a command-line overlay inserts or configures: the profile patch cannot override them, so their forms are read-only. */
  function overlayOwned(): Set<string> {
    const owned = new Set<string>()
    for (const patch of ctx.get('profileContext')?.overlays ?? []) {
      for (const row of patch.insert ?? []) if (row.id) owned.add(row.id)
      if (patch.insert === undefined && patch.id !== undefined && patch.config !== undefined) owned.add(patch.id)
    }
    return owned
  }
  function modelNamespaces(): Set<string> {
    return new Set(ctx.llm.listConfigurableProviders().map(entry => entry.settingsNs))
  }
  async function write(ns: string, ops: readonly SettingsPathOp[], revision: number | undefined): Promise<void> {
    if (ops.length === 0) return
    const service = ctx.get('settings')
    if (service === undefined) fail('settings_unavailable')
    try {
      await service.mutate(ns, ops, revision)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT') fail('settings_conflict')
      if (error instanceof Error && /overridden by a home patch or command-line overlay/.test(error.message)) fail('settings_overridden')
      // Ordinary (non-volatile) fields restart their plugin; Settings edits only fields applied in place.
      if (error instanceof Error && /No configurable plugin entry|has no volatile fields|is not volatile/.test(error.message)) fail('settings_not_live')
      throw error
    }
  }

  const settings: AppSettings = {
    async models() {
      const rows: AppModelProvider[] = []
      const owned = overlayOwned()
      for (const { entry, descriptor } of providers()) {
        const ref = refOf(descriptor, entry.settingsPath)
        rows.push({
          provider: entry.provider, display_name: entry.displayName, ns: entry.settingsNs, path: [...entry.settingsPath],
          credential_ref: ref, credential: await credential(ref), settings_writable: !owned.has(entry.settingsNs),
          ...(descriptor === undefined ? {} : { form: {
            schema: descriptor.schema, value: descriptor.value, base: descriptor.base ?? null, user: descriptor.user ?? null,
            revision: descriptor.revision, writable: !owned.has(entry.settingsNs),
          } }),
        })
      }
      return { providers: rows }
    },
    async saveModel(raw) {
      const input = ModelsWrite.parse(raw)
      const target = providers().find(row => row.entry.settingsNs === input.ns)
      if (target === undefined) fail('settings_namespace_unknown')
      // Refuse a read-only key before the settings write, so a refused card commits nothing.
      const ref = refOf(target.descriptor, target.entry.settingsPath)
      if (input.api_key !== undefined && !(await ctx.credentials.describe(ref)).writable) fail('credential_read_only')
      await write(input.ns, input.ops, input.revision)
      // The card does not edit apiKeyEnv, so the reference read before the write still names the stored key.
      if (input.api_key !== undefined) await ctx.credentials.set(ref, input.api_key)
      return settings.models()
    },
    async clearModelKey(raw) {
      const input = Namespace.parse(raw)
      const target = providers().find(row => row.entry.settingsNs === input.ns)
      if (target === undefined) fail('settings_namespace_unknown')
      const ref = refOf(target.descriptor, target.entry.settingsPath)
      if (!(await ctx.credentials.describe(ref)).writable) fail('credential_read_only')
      await ctx.credentials.unset(ref)
      return settings.models()
    },
    async plugins() {
      const snapshot = await readPluginInventory(ctx)
      const owned = overlayOwned()
      const forms = new Set(descriptors().filter(row => row.autoGenerate && row.ns !== options.appEntryId).map(row => row.ns as string))
      const models = modelNamespaces()
      // A package subpath row (this app) has no manifest of its own; it shows its package's icon beside its own module name.
      const iconOf = (moduleName: string) => snapshot.entries.find(row => moduleName.startsWith(`${row.moduleName}/`))?.meta?.icon
      return {
        entries: snapshot.entries.map((entry) => {
          const icon = entry.meta === undefined ? iconOf(entry.moduleName) : undefined
          const meta = entry.meta ?? (icon === undefined ? undefined : { icon })
          const ns = entry.entryId.replace(/^include:/, '')
          return {
            entry_id: entry.entryId, ns, module_name: entry.moduleName, enabled: entry.enabled, phase: entry.fiberPhase,
            configurable: forms.has(ns) ? 'form' as const : models.has(ns) ? 'models' as const : 'none' as const,
            settings_writable: !owned.has(ns),
            ...(meta === undefined ? {} : { meta }),
          }
        }),
      }
    },
    pluginConfig(raw) {
      const { ns } = Namespace.parse(raw)
      if (ns === options.appEntryId) fail('settings_namespace_unknown')
      const descriptor = descriptors().find(row => row.ns === ns)
      if (descriptor === undefined) fail('settings_namespace_unknown')
      return {
        ns, schema: descriptor.schema, value: descriptor.value, base: descriptor.base ?? null, user: descriptor.user ?? null,
        revision: descriptor.revision, writable: !overlayOwned().has(ns),
      }
    },
    async savePluginConfig(raw) {
      const input = Write.parse(raw)
      if (input.ns === options.appEntryId || modelNamespaces().has(input.ns)) fail('settings_namespace_unknown')
      await write(input.ns, input.ops, input.revision)
      return settings.pluginConfig({ ns: input.ns })
    },
    async credential() {
      const target = providers().find(row => row.entry.provider === options.provider)
      return credential(target === undefined ? fallbackRef : refOf(target.descriptor, target.entry.settingsPath))
    },
  }
  return settings
}
