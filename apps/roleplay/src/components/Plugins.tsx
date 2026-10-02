/** Plugin pages in the DeepSeek Harness layouts: the Settings inventory cards and the sidebar plugin list with config forms. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppLocalizedText, AppPluginConfigView, AppPluginEntry, AppPluginsView, AppSettingsWrite,
} from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { translate, type Language, type MessageKey } from '../i18n.ts'
import { getPath, hasPath, rehydrate, type SchemaNode } from '../settings-schema.ts'
import { Icon } from './Icon.tsx'

/** Host operations the plugin pages invoke. */
export interface PluginOperations {
  list: () => Promise<AppPluginsView>
  config: (ns: string) => Promise<AppPluginConfigView>
  save: (input: AppSettingsWrite) => Promise<AppPluginConfigView>
  explain: (error: unknown) => MessageKey
}

const PHASE_KEYS = {
  pending: 'phasePending', loading: 'phaseLoading', active: 'phaseActive', failed: 'phaseFailed', unloading: 'phaseUnloading',
} as const satisfies Record<NonNullable<AppPluginEntry['phase']>, MessageKey>

function localized(text: AppLocalizedText | undefined, language: Language): string | undefined {
  if (text === undefined) return undefined
  if (typeof text === 'string') return text
  return text[language === 'zh' ? 'zh' : 'en'] ?? text['zh-CN'] ?? text.en
}
/** Technical module names shortened the way the Harness inventory shows them. */
function shortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped.replace(/^cordis:/, '').replace(/^cordis-plugin-/, '').replace(/^dsh-(?:host-|client-)?/, '')
}
function pluginText(entry: AppPluginEntry, language: Language) {
  const title = entry.meta?.title
  return {
    title: typeof title === 'object' ? localized(title, language) ?? shortName(entry.module_name) : shortName(title ?? entry.module_name),
    description: localized(entry.meta?.description, language) || undefined,
  }
}
function usePlugins(operations: PluginOperations) {
  const [view, setView] = useState<AppPluginsView | null>(null)
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const live = useRef(true)
  const reload = () => {
    setFailed(null)
    operations.list().then(
      (next) => { if (live.current) setView(next) },
      (error: unknown) => { if (live.current) setFailed(operations.explain(error)) },
    )
  }
  useEffect(() => {
    live.current = true
    reload()
    return () => { live.current = false }
    // One read per mount; the refresh control requests another.
  }, [])
  return { view, failed, reload }
}

/**
 * Settings → Built-in plugins: searchable expandable cards with module, configuration and runtime facts.
 * @param props - Interface language and host operations.
 * @returns The inventory section.
 */
export function PluginInventorySection({ language, operations }: { language: Language; operations: PluginOperations }) {
  const t = (key: MessageKey) => translate(language, key)
  const { view, failed, reload } = usePlugins(operations)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const entries = (view?.entries ?? []).filter((entry) => {
    if (!normalized) return true
    const { title, description } = pluginText(entry, language)
    return [entry.module_name, entry.entry_id, title, description].some(value => value?.toLocaleLowerCase().includes(normalized))
  })
  return (
    <section className="inventory-section" aria-label={t('builtinPlugins')}>
      <h2 className="section-title">{t('builtinPlugins')}</h2>
      <p className="section-intro">{t('builtinPluginsIntro')}</p>
      <label className="inventory-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          value={query}
          placeholder={t('searchPlugins')}
          aria-label={t('searchPlugins')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </label>
      {failed ? (
        <p className="section-error" role="alert">
          {t(failed)} <button type="button" className="link-button" onClick={reload}>{t('retry')}</button>
        </p>
      ) : null}
      {view === null && !failed ? <p className="section-intro" role="status">{t('loading')}</p> : null}
      {view !== null ? (
        <div className="inventory-group-head">
          <span className="inventory-group-title">{t('profilePlugins')}</span>
          <span className="inventory-group-meta">{`${t('profilePluginsSubtitle')} · ${String(entries.length)}`}</span>
        </div>
      ) : null}
      <ul className="inventory-cards">
        {entries.map((entry) => {
          const { title, description } = pluginText(entry, language)
          const open = expanded === entry.entry_id
          const failedPhase = entry.phase === 'failed'
          const stateKey: MessageKey = failedPhase ? 'phaseFailed' : entry.enabled ? 'enabledTag' : 'disabledTag'
          return (
            <li key={entry.entry_id} className="inventory-card" data-open={open ? 'true' : undefined} data-failed={failedPhase ? 'true' : undefined}>
              <button
                type="button"
                className="inventory-card-content"
                aria-expanded={open}
                onClick={() => { setExpanded(open ? null : entry.entry_id) }}
              >
                <span className="inventory-card-row">
                  <strong className="inventory-card-title" title={entry.module_name}>{title}</strong>
                  <span className="inventory-card-trailing">
                    {failedPhase || !entry.enabled ? <span className={`state-tag ${failedPhase ? 'danger' : 'neutral'}`}>{t(stateKey)}</span> : null}
                    <Icon name="chevronDown" size={12} />
                  </span>
                </span>
                {description ? <span className="inventory-card-description">{description}</span> : null}
              </button>
              {entry.meta?.error ? <p className="inventory-broken">{entry.meta.error}</p> : null}
              {open ? (
                <div className="inventory-card-details">
                  <code className="inventory-entry">{entry.entry_id.replace(/^include:/, '')}</code>
                  <dl className="inventory-facts">
                    <div><dt>{t('moduleLabel')}</dt><dd>{entry.module_name}</dd></div>
                    <div><dt>{t('configurationLabel')}</dt><dd>{t(entry.enabled ? 'enabledTag' : 'disabledTag')}</dd></div>
                    <div>
                      <dt>{t('runtimeLabel')}</dt>
                      <dd>{entry.phase === null ? t('phaseNone') : t(PHASE_KEYS[entry.phase])}</dd>
                    </div>
                  </dl>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {view !== null && !entries.length ? <p className="section-intro">{t(normalized ? 'pluginsNoMatch' : 'pluginsEmpty')}</p> : null}
    </section>
  )
}

/**
 * Sidebar plugin page: the plugin list and, for an entry with a live form, its detail page and generated settings form.
 * @param props - Interface language, host operations and the Models shortcut.
 * @returns The page that replaces the story column while open.
 */
export function PluginManagerPage({ language, operations, onOpenModels }: {
  language: Language
  operations: PluginOperations
  onOpenModels: () => void
}) {
  const t = (key: MessageKey) => translate(language, key)
  const { view, failed, reload } = usePlugins(operations)
  const [selected, setSelected] = useState<string | null>(null)
  const entry = view?.entries.find(row => row.entry_id === selected)
  if (entry !== undefined) {
    return <PluginDetail entry={entry} language={language} operations={operations} onBack={() => { setSelected(null) }} />
  }
  const rows = view?.entries ?? []
  return (
    <div className="plugin-page">
      <div className="plugin-page-head">
        <div>
          <h1 className="plugin-page-title">{t('pluginsTitle')}</h1>
          <p className="plugin-page-intro">{t('pluginsIntro')}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t('refresh')} onClick={reload}>
          <Icon name="refresh" />
        </button>
      </div>
      {failed ? (
        <p className="section-error" role="alert">
          {t(failed)} <button type="button" className="link-button" onClick={reload}>{t('retry')}</button>
        </p>
      ) : null}
      {view === null && !failed ? <p className="section-intro" role="status">{t('loading')}</p> : null}
      {view !== null ? (
        <section className="plugin-group" aria-label={t('profilePlugins')}>
          <div className="plugin-group-head">
            <h2 className="plugin-group-title">{t('profilePlugins')}</h2>
            <span className="plugin-group-count">{rows.length}</span>
          </div>
          <ul className="plugin-cards">
            {rows.map((row) => {
              const { title, description } = pluginText(row, language)
              const opens = row.configurable === 'form'
              return (
                <li key={row.entry_id} className={`plugin-card ${opens || row.configurable === 'models' ? 'plugin-card-link' : ''}`}>
                  <div className="plugin-card-head">
                    <span className="plugin-card-icon" aria-hidden="true">
                      {row.meta?.icon ? <img src={row.meta.icon} alt="" width={28} height={28} /> : <Icon name="plugin" size={20} />}
                    </span>
                    <div className="plugin-card-main">
                      <div className="plugin-title-row">
                        {opens || row.configurable === 'models' ? (
                          <button
                            type="button"
                            className="plugin-card-title plugin-card-open"
                            aria-label={translate(language, 'openPlugin').replace('{name}', title)}
                            onClick={() => { if (opens) setSelected(row.entry_id); else onOpenModels() }}
                          >
                            {title}
                          </button>
                        ) : <span className="plugin-card-title">{title}</span>}
                        {row.phase === 'failed' ? <span className="state-tag danger">{t('statusProblem')}</span> : null}
                        {!row.enabled ? <span className="state-tag neutral">{t('disabledTag')}</span> : null}
                      </div>
                      <span className="plugin-card-desc">{description ?? row.module_name}</span>
                    </div>
                    <span className="plugin-card-end">
                      {row.configurable === 'none' ? <span className="plugin-card-note">{t('launchConfigOnly')}</span> : <Icon name="chevron" size={14} />}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

type FieldKind = 'number' | 'string' | 'boolean' | 'choice'
interface FormField { key: string; kind: FieldKind; node: SchemaNode; choices: string[] }

/** Scalar top-level fields a generated form can edit; nested objects and lists stay in cordis.patch.yml. */
function formFields(root: SchemaNode | undefined): FormField[] {
  if (root?.type !== 'object') return []
  return Object.entries((root.dict ?? {}) as Record<string, SchemaNode>).flatMap(([key, node]): FormField[] => {
    if (node.meta.role === 'secret') return []
    if (node.type === 'number' || node.type === 'string' || node.type === 'boolean') return [{ key, kind: node.type, node, choices: [] }]
    if (node.type === 'union') {
      const choices = ((node.list ?? []) as SchemaNode[]).flatMap(option => (option.type === 'const' && typeof option.value === 'string' ? [option.value] : []))
      return choices.length === (node.list ?? []).length ? [{ key, kind: 'choice', node, choices }] : []
    }
    return []
  })
}

function PluginDetail({ entry, language, operations, onBack }: {
  entry: AppPluginEntry
  language: Language
  operations: PluginOperations
  onBack: () => void
}) {
  const t = (key: MessageKey) => translate(language, key)
  const { title, description } = pluginText(entry, language)
  const [form, setForm] = useState<AppPluginConfigView | null>(null)
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string | boolean | null>>({})
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState<MessageKey | null>(null)
  const [saved, setSaved] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    operations.config(entry.ns).then(
      (next) => { if (live.current) setForm(next) },
      (error: unknown) => { if (live.current) setFailed(operations.explain(error)) },
    )
    return () => { live.current = false }
  }, [entry.ns])
  const root = useMemo(() => (form ? rehydrate(form.schema) : undefined), [form])
  const fields = useMemo(() => formFields(root), [root])
  const textOf = (field: FormField): string | boolean => {
    const draft = drafts[field.key]
    if (draft !== undefined && draft !== null) return draft
    const value = getPath(form?.value, [field.key])
    if (field.kind === 'boolean') return value === true
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  }
  const parse = (field: FormField, text: string | boolean): { ok: true; value: unknown } | { ok: false } => {
    if (field.kind === 'boolean') return { ok: true, value: text === true }
    if (typeof text !== 'string') return { ok: false }
    if (field.kind === 'number') {
      const value = Number(text.trim())
      if (!text.trim() || !Number.isFinite(value)) return { ok: false }
      try { (field.node as (input: unknown) => unknown)(value) } catch { return { ok: false } }
      return { ok: true, value }
    }
    return { ok: true, value: text }
  }
  const invalid = fields.some((field) => {
    const draft = drafts[field.key]
    return draft !== undefined && draft !== null && !parse(field, draft).ok
  })
  const dirty = Object.keys(drafts).length > 0
  const writable = form?.writable === true && entry.settings_writable
  const save = async () => {
    if (!form) return
    const ops: AppSettingsWrite['ops'] = []
    for (const field of fields) {
      const draft = drafts[field.key]
      if (draft === undefined) continue
      if (draft === null) { ops.push({ op: 'unset', path: [field.key] }); continue }
      const parsed = parse(field, draft)
      if (!parsed.ok) return
      ops.push({ op: 'set', path: [field.key], value: parsed.value as string | number | boolean })
    }
    setSaving(true)
    setSaveFailed(null)
    setSaved(false)
    try {
      const next = await operations.save({ ns: form.ns, ops, revision: form.revision })
      if (!live.current) return
      setForm(next)
      setDrafts({})
      setSaved(true)
    } catch (error) {
      if (live.current) setSaveFailed(operations.explain(error))
    } finally {
      if (live.current) setSaving(false)
    }
  }
  return (
    <div className="plugin-page plugin-detail">
      <div className="plugin-detail-top">
        <button type="button" className="plugin-crumb" aria-label={t('backToPlugins')} onClick={onBack}>
          <Icon name="chevronLeft" size={12} />
          <span>{t('pluginsList')}</span>
        </button>
        <span className="plugin-card-icon plugin-detail-icon" aria-hidden="true">
          {entry.meta?.icon ? <img src={entry.meta.icon} alt="" width={28} height={28} /> : <Icon name="plugin" size={20} />}
        </span>
      </div>
      <h1 className="plugin-detail-title">{title}</h1>
      <p className="plugin-detail-desc">{description ?? entry.module_name}</p>
      {failed ? <p className="section-error" role="alert">{t(failed)}</p> : null}
      {form !== null ? (
        <div className="settings-form">
          {!writable ? <p className="settings-form-note" role="status">{t('settingsOverlayLocked')}</p> : null}
          {fields.map((field) => {
            const overridden = hasPath(form.user, [field.key]) && drafts[field.key] !== null
            const text = textOf(field)
            const fieldInvalid = drafts[field.key] !== undefined && drafts[field.key] !== null && !parse(field, text).ok
            const id = `plugin-field-${entry.ns}-${field.key}`
            const description = typeof field.node.meta.description === 'string' ? field.node.meta.description : undefined
            return (
              <div className="settings-field" key={field.key}>
                <div className="settings-field-head">
                  <label className="settings-field-label" htmlFor={id}>{field.key}</label>
                  {overridden ? (
                    <>
                      <span className="state-tag neutral">{t('overridden')}</span>
                      <button type="button" className="link-button" disabled={!writable} onClick={() => { setDrafts(current => ({ ...current, [field.key]: null })) }}>
                        {t('resetField')}
                      </button>
                    </>
                  ) : null}
                </div>
                {field.kind === 'boolean' ? (
                  <input
                    id={id}
                    type="checkbox"
                    className="settings-field-check"
                    checked={text === true}
                    disabled={!writable || saving}
                    onChange={(event) => { setDrafts(current => ({ ...current, [field.key]: event.target.checked })) }}
                  />
                ) : field.kind === 'choice' ? (
                  <select
                    id={id}
                    className="settings-field-input"
                    value={String(text)}
                    disabled={!writable || saving}
                    onChange={(event) => { setDrafts(current => ({ ...current, [field.key]: event.target.value })) }}
                  >
                    {String(text) === '' ? <option value="">—</option> : null}
                    {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                  </select>
                ) : (
                  <input
                    id={id}
                    className="settings-field-input"
                    type="text"
                    inputMode={field.kind === 'number' ? 'numeric' : undefined}
                    value={String(text)}
                    aria-invalid={fieldInvalid}
                    disabled={!writable || saving}
                    onChange={(event) => { setDrafts(current => ({ ...current, [field.key]: event.target.value })) }}
                  />
                )}
                <p className={`settings-field-hint ${fieldInvalid ? 'invalid' : ''}`}>
                  {fieldInvalid ? t('invalidValue') : description ?? ''}
                </p>
              </div>
            )
          })}
          {!fields.length ? <p className="settings-form-note">{t('noEditableFields')}</p> : null}
          <div className="settings-form-footer">
            {saveFailed ? <p className="settings-form-failed" role="status">{t(saveFailed)}</p> : null}
            {saved && !dirty ? <p className="settings-form-saved" role="status">{t('pluginConfigSaved')}</p> : null}
            <button type="button" className="settings-form-save" disabled={!dirty || invalid || saving || !writable} onClick={() => void save()}>
              {t(saving ? 'applying' : 'apply')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
