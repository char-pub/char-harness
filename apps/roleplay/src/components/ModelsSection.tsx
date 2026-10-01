/** Models settings section in the DeepSeek Harness layout: provider rows, one editor card with key, endpoint and model catalog. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppModelProvider, AppModelsView, AppModelsWrite } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { translate, type Language, type MessageKey } from '../i18n.ts'
import { getPath, hasPath, nodeAt, pathOps, rehydrate } from '../settings-schema.ts'
import { Icon } from './Icon.tsx'

/** Host operations the section invokes; each resolves with refreshed providers or rejects with a machine code. */
export interface ModelsOperations {
  load: () => Promise<AppModelsView>
  save: (input: AppModelsWrite) => Promise<AppModelsView>
  clearKey: (ns: string) => Promise<AppModelsView>
  /** Interface message for a rejected operation. */
  explain: (error: unknown) => MessageKey
}

type Draft = Record<string, unknown>
type ModelDraft = Record<string, unknown>

const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/
const CAPACITY = /^(\d+(?:\.\d+)?)([km])?$/i

/** The original Models page's key validation: printable ASCII, no `NAME=value` line, no surrounding quotes. */
function keyFailure(draft: string): MessageKey | undefined {
  if (draft.length === 0) return undefined
  const value = draft.trim()
  if (value.length === 0) return 'keyBlank'
  const quoted = /^(["'`]).*\1$/.test(value) && value.length > 1
  if (ENV_LINE.test(value) || quoted || !LEGAL_API_KEY.test(value)) return 'keyIllegal'
  return undefined
}
/** Parse a capacity such as `131072`, `256K` or `1M`; undefined clears the field, NaN marks invalid text. */
function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY.exec(trimmed)
  if (match === null) return Number.NaN
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1
  return Math.round(Number(match[1]) * scale)
}
function formatCapacity(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return ''
  if (value % 1_000_000 === 0) return `${String(value / 1_000_000)}M`
  if (value % 1_000 === 0) return `${String(value / 1_000)}K`
  return String(value)
}
function modelRows(value: unknown): ModelDraft[] {
  return Array.isArray(value) ? value.map(row => (typeof row === 'object' && row !== null && !Array.isArray(row) ? { ...row as ModelDraft } : {})) : []
}
/** First invalid model row, using the original catalog rules. */
function modelFailure(models: readonly ModelDraft[] | undefined): { index: number; key: MessageKey } | undefined {
  if (models === undefined) return undefined
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) return { index, key: 'modelIdRequired' }
    if (seen.has(id)) return { index, key: 'modelIdDuplicate' }
    seen.add(id)
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const value = model[field]
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
        return { index, key: field === 'contextWindow' ? 'modelContextInvalid' : 'modelMaxTokensInvalid' }
      }
    }
  }
  return undefined
}

/**
 * Render the Models section.
 * @param props - Interface language and host operations.
 * @returns The section with provider rows and at most one open editor.
 */
export function ModelsSection({ language, operations }: { language: Language; operations: ModelsOperations }) {
  const t = (key: MessageKey) => translate(language, key)
  const [view, setView] = useState<AppModelsView | null>(null)
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const live = useRef(true)
  const reload = () => {
    setFailed(null)
    operations.load().then(
      (next) => { if (live.current) setView(next) },
      (error: unknown) => { if (live.current) setFailed(operations.explain(error)) },
    )
  }
  useEffect(() => {
    live.current = true
    reload()
    return () => { live.current = false }
    // One read per mount; edits refresh from their own write results.
  }, [])
  // First-run posture: with no usable provider, the first provider opens as its setup card until the user closes it.
  const firstRun = view !== null && !dismissed && !view.providers.some(row => row.credential.configured)
  const open = editing ?? (firstRun ? view.providers[0]?.ns ?? null : null)
  return (
    <section className="models-section" aria-label={t('settingsModel')}>
      <h2 className="section-title">{t('settingsModel')}</h2>
      <p className="section-intro">{t('modelsIntro')}</p>
      {saved ? <p className="saved-notice" role="status">{saved}</p> : null}
      {failed ? (
        <p className="section-error" role="alert">
          {t(failed)}{' '}
          <button type="button" className="link-button" onClick={reload}>{t('retry')}</button>
        </p>
      ) : null}
      {view === null && !failed ? <p className="section-intro" role="status">{t('loading')}</p> : null}
      <ul className="provider-rows">
        {view?.providers.map(row => (
          <li key={row.ns}>
            {open === row.ns ? (
              <ProviderEditor
                row={row}
                language={language}
                operations={operations}
                onClose={(next, changed) => {
                  if (next) setView(next)
                  if (changed) setSaved(translate(language, 'savedProvider').replace('{provider}', row.display_name))
                  setEditing(null)
                  setDismissed(true)
                }}
              />
            ) : (
              <div className="provider-row">
                <span className="provider-identity">
                  <span className="provider-name">{row.display_name}</span>
                  <span
                    className={`credential-dot ${row.credential.configured ? 'configured' : 'missing'}`}
                    role="img"
                    aria-label={t(row.credential.configured ? 'credentialConfiguredDot' : 'credentialMissingDot')}
                    title={t(row.credential.configured ? 'credentialConfiguredDot' : 'credentialMissingDot')}
                  />
                </span>
                <button
                  type="button"
                  className="row-button"
                  aria-label={translate(language, 'editProvider').replace('{provider}', row.display_name)}
                  onClick={() => { setSaved(null); setEditing(row.ns) }}
                >
                  {t('edit')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {view !== null && !view.providers.length ? <p className="section-intro">{t('modelsEmpty')}</p> : null}
    </section>
  )
}

function ProviderEditor({ row, language, operations, onClose }: {
  row: AppModelProvider
  language: Language
  operations: ModelsOperations
  onClose: (view: AppModelsView | null, changed: boolean) => void
}) {
  const t = (key: MessageKey) => translate(language, key)
  const form = row.form
  const root = useMemo(() => (form ? rehydrate(form.schema) : undefined), [form])
  const original = form ? getPath(form.user, row.path) : undefined
  const [draft, setDraft] = useState<Draft>(() => (typeof original === 'object' && original !== null ? structuredClone(original as Draft) : {}))
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: MessageKey } | null>(null)
  const fallback = form ? getPath(form.value, row.path) : undefined
  const keyLocked = !row.credential.writable
  const shownKeyFailure = keyFailure(key)
  const stringAt = (source: unknown, field: string) => {
    const value = getPath(source, [field])
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  const setField = (field: string, value: unknown) => {
    setDraft((current) => {
      const next = { ...current }
      if (value === undefined) Reflect.deleteProperty(next, field)
      else next[field] = value
      return next
    })
  }
  const overridden = hasPath(draft, ['models'])
  const schemaDefault: unknown = root ? nodeAt(root, [...row.path, 'models'])?.meta.default : undefined
  const inherited = form ? (getPath(form.base, [...row.path, 'models']) ?? schemaDefault) : undefined
  const models = modelRows(overridden ? draft.models : inherited)
  const catalogFailure = modelFailure(overridden ? modelRows(draft.models) : undefined)
  const settingsReadOnly = !row.settings_writable || form === undefined || !form.writable
  const submitDisabled = busy || shownKeyFailure !== undefined || catalogFailure !== undefined
    || (settingsReadOnly && !key.trim()) || (keyLocked && !Object.keys(pathOps(row.path, original, draft)).length)

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      const ops = form && !settingsReadOnly ? pathOps(row.path, original, draft) : []
      if (!ops.length && !key.trim()) { onClose(null, false); return }
      const next = await operations.save({
        ns: row.ns, ops, ...(form === undefined ? {} : { revision: form.revision }), ...(key.trim() ? { api_key: key.trim() } : {}),
      })
      onClose(next, true)
    } catch (cause) {
      setError({ key: operations.explain(cause) })
    } finally {
      setBusy(false)
    }
  }
  const clearKey = async () => {
    setBusy(true)
    setError(null)
    try {
      onClose(await operations.clearKey(row.ns), true)
    } catch (cause) {
      setError({ key: operations.explain(cause) })
    } finally {
      setBusy(false)
    }
  }
  const setModels = (next: ModelDraft[]) => { setField('models', next) }
  const updateModel = (index: number, field: string, value: unknown) => {
    setModels(models.map((model, at) => {
      if (at !== index) return model
      const copy = { ...model }
      if (value === undefined) Reflect.deleteProperty(copy, field)
      else copy[field] = value
      return copy
    }))
  }
  return (
    <div className="provider-editor">
      <div className="editor-header">
        <span className="editor-title">{row.display_name}</span>
        {row.provider !== row.display_name ? <span className="editor-route">{row.provider}</span> : null}
      </div>
      <div className="editor-field">
        <span className="field-label" id={`${row.ns}-key-label`}>{t('apiKey')}</span>
        <input
          aria-labelledby={`${row.ns}-key-label`}
          className="editor-input"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={key}
          placeholder={t(keyLocked ? 'keyEnvLocked' : row.credential.configured ? 'keyStored' : 'apiKeyPlaceholder')}
          aria-invalid={shownKeyFailure !== undefined}
          disabled={busy || keyLocked}
          onChange={(event) => { setKey(event.target.value) }}
        />
        {shownKeyFailure ? <span className="editor-error">{t(shownKeyFailure)}</span> : null}
      </div>
      {form === undefined ? <p className="advanced-hint">{t('modelFormUnavailable')}</p> : (
        <details className="customized">
          <summary>{t('customized')}</summary>
          <div className="customized-body">
            {settingsReadOnly ? <p className="advanced-hint">{t('settingsOverlayLocked')}</p> : null}
            <div className="editor-field">
              <span className="field-label" id={`${row.ns}-endpoint-label`}>{t('baseUrl')}</span>
              <input
                className="editor-input"
                type="text"
                value={stringAt(draft, 'baseURL') ?? ''}
                placeholder={stringAt(fallback, 'baseURL') ?? t('deepSeekBaseUrl')}
                aria-labelledby={`${row.ns}-endpoint-label`}
                aria-describedby={`${row.ns}-endpoint-hint`}
                disabled={busy || settingsReadOnly}
                onChange={(event) => { setField('baseURL', event.target.value.trim() ? event.target.value : undefined) }}
              />
              <span className="advanced-hint" id={`${row.ns}-endpoint-hint`}>{t('deepSeekEndpointHint')}</span>
            </div>
            <section className="model-catalog" aria-label={t('modelCatalog')}>
              <div className="model-list-head">
                <span className="model-catalog-heading">
                  <span className="model-catalog-title">{t('modelCatalog')}</span>
                  <span className="model-catalog-meta">{t(overridden ? 'modelsCustomized' : 'modelsInherited')}</span>
                </span>
                {overridden ? (
                  <button type="button" className="link-button" disabled={busy || settingsReadOnly} onClick={() => { setField('models', undefined) }}>
                    {t('resetModels')}
                  </button>
                ) : null}
              </div>
              {models.length ? (
                <div className="model-list">
                  {models.map((model, index) => (
                    <ModelRow
                      key={index}
                      model={model}
                      position={index + 1}
                      language={language}
                      disabled={busy || settingsReadOnly}
                      onField={(field, value) => { updateModel(index, field, value) }}
                      onRemove={() => { setModels(models.filter((_model, at) => at !== index)) }}
                    />
                  ))}
                </div>
              ) : <p className="model-empty">{t('modelCatalogEmpty')}</p>}
              <button
                type="button"
                className="add-model-button"
                disabled={busy || settingsReadOnly}
                onClick={() => { setModels([...models, { id: '' }]) }}
              >
                <Icon name="plus" size={14} />
                {t('addModel')}
              </button>
              {catalogFailure ? (
                <p className="advanced-hint">{`${t('model')} ${String(catalogFailure.index + 1)}: ${t(catalogFailure.key)}`}</p>
              ) : null}
            </section>
          </div>
        </details>
      )}
      {error ? <p className="editor-error" role="alert">{t(error.key)}</p> : null}
      <div className="editor-actions">
        {row.credential.configured && row.credential.source === 'file' ? (
          <button type="button" className="secondary-button danger-left" disabled={busy} onClick={() => void clearKey()}>
            {t('apiKeyClear')}
          </button>
        ) : null}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { onClose(null, false) }}>{t('cancel')}</button>
        <button type="button" className="primary-button" disabled={submitDisabled} onClick={() => void apply()}>
          {t(busy ? 'applying' : 'apply')}
        </button>
      </div>
    </div>
  )
}

function ModelRow({ model, position, language, disabled, onField, onRemove }: {
  model: ModelDraft
  position: number
  language: Language
  disabled: boolean
  onField: (field: string, value: unknown) => void
  onRemove: () => void
}): ReactNode {
  const t = (key: MessageKey) => translate(language, key)
  const [expanded, setExpanded] = useState(false)
  const [typed, setTyped] = useState<Record<string, string>>({})
  const capacity = (field: 'contextWindow' | 'maxTokens') => ({
    value: typed[field] ?? formatCapacity(model[field]),
    onChange: (text: string) => {
      setTyped(current => ({ ...current, [field]: text }))
      onField(field, parseCapacity(text))
    },
  })
  return (
    <div className="model-entry">
      <div className="model-row">
        {(['id', 'name'] as const).map(field => (
          <input
            key={field}
            className="editor-input"
            type="text"
            value={typeof model[field] === 'string' ? model[field] : ''}
            placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
            aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
            disabled={disabled}
            onChange={(event) => { onField(field, field === 'name' && !event.target.value ? undefined : event.target.value) }}
          />
        ))}
        <button
          type="button"
          className="model-icon-button"
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={expanded}
          onClick={() => { setExpanded(value => !value) }}
        >
          <Icon name={expanded ? 'chevronDown' : 'chevron'} size={14} />
        </button>
        <button
          type="button"
          className="model-icon-button danger"
          aria-label={`${t('removeModel')} ${String(position)}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      {expanded ? (
        <div className="model-advanced">
          {(['contextWindow', 'maxTokens'] as const).map(field => (
            <label className="model-field" key={field}>
              <span className="model-field-label">{t(field)}</span>
              <input
                className="editor-input"
                type="text"
                inputMode="numeric"
                placeholder={t('capacityPlaceholder')}
                disabled={disabled}
                {...capacity(field)}
                onChange={(event) => { capacity(field).onChange(event.target.value) }}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}
