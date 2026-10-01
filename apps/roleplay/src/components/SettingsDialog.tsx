/** Settings panel in the DeepSeek Harness layout: section rail, rows with hairline separators, close in the header. */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AppStatus } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives/src/useModalLayer.ts'
import { translate, type Language, type MessageKey } from '../i18n.ts'
import { Icon, type IconName } from './Icon.tsx'

/** Interface theme preference; `system` follows the operating system. */
export type Theme = 'light' | 'dark' | 'system'
/** Content font-size bounds shared with the DeepSeek Harness Settings range. */
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 22
type Section = 'general' | 'model' | 'registry'

/** Local preferences and host status shown by the panel; every host change goes through an explicit callback. */
export interface SettingsDialogProps {
  language: Language
  theme: Theme
  fontSize: number
  status: AppStatus | null
  registryOrigin: string | undefined
  busy: boolean
  onLanguage: (value: Language) => void
  onTheme: (value: Theme) => void
  onFontSize: (value: number) => void
  onAuthorize: () => void
  onRefresh: () => void
  /** Store a key; resolves with an interface message describing the committed result. */
  onSaveCredential: (value: string) => Promise<MessageKey>
  onClearCredential: () => Promise<MessageKey>
  onClose: () => void
}

/**
 * Render the body-portaled settings panel.
 * @param props - Current preferences, host status and explicit change callbacks.
 * @returns The modal settings panel.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { language, onClose } = props
  const t = (key: MessageKey) => translate(language, key)
  const [section, setSection] = useState<Section>('general')
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useModalLayer(panel, true, onClose)
  const sections: ReadonlyArray<[Section, IconName, MessageKey]> = [
    ['general', 'general', 'settingsGeneral'],
    ['model', 'model', 'settingsModel'],
    ['registry', 'registry', 'registry'],
  ]
  return createPortal(
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={onClose} />
      <div ref={panel} tabIndex={-1} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className="settings-nav" aria-label={t('settingsTitle')}>
          <div className="settings-nav-title" id={titleId}>
            {t('settingsTitle')}
          </div>
          <div className="settings-nav-list">
            {sections.map(([id, icon, label]) => (
              <button
                key={id}
                type="button"
                className={`settings-nav-cell ${section === id ? 'active' : ''}`}
                aria-current={section === id ? 'true' : undefined}
                data-modal-autofocus={section === id ? '' : undefined}
                onClick={() => {
                  setSection(id)
                }}
              >
                <Icon name={icon} />
                <span>{t(label)}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-content">
          <div className="settings-header">
            <button type="button" className="settings-close" aria-label={t('close')} onClick={onClose}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="settings-options">
            {section === 'general' ? <GeneralSection {...props} /> : null}
            {section === 'model' ? <ModelSection {...props} /> : null}
            {section === 'registry' ? <RegistrySection {...props} /> : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function GeneralSection({ language, theme, fontSize, onLanguage, onTheme, onFontSize }: SettingsDialogProps) {
  const t = (key: MessageKey) => translate(language, key)
  const themes: ReadonlyArray<[Theme, IconName]> = [
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
  ]
  return (
    <section className="settings-section" aria-label={t('settingsGeneral')}>
      <label className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-title">{t('interfaceLanguage')}</span>
          <span className="settings-row-desc">{t('languageHint')}</span>
        </span>
        <select
          className="settings-select"
          value={language}
          onChange={(e) => {
            onLanguage(e.target.value === 'zh' ? 'zh' : 'en')
          }}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <div className="settings-group" role="radiogroup" aria-label={t('appearance')}>
        <span className="settings-row-title">{t('appearance')}</span>
        <div className="theme-cubes">
          {themes.map(([value, icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              className={`theme-cube ${theme === value ? 'selected' : ''}`}
              onClick={() => {
                onTheme(value)
              }}
            >
              <Icon name={icon} />
              <span>{t(value)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-title">{t('fontSize')}</span>
          <span className="settings-row-desc">{t('fontSizeHint')}</span>
        </span>
        <span className="font-stepper">
          <button
            type="button"
            className="stepper-button"
            aria-label={t('fontSizeDecrease')}
            disabled={fontSize <= FONT_SIZE_MIN}
            onClick={() => {
              onFontSize(fontSize - 1)
            }}
          >
            −
          </button>
          <output className="stepper-value" aria-live="polite">
            {fontSize}
          </output>
          <button
            type="button"
            className="stepper-button"
            aria-label={t('fontSizeIncrease')}
            disabled={fontSize >= FONT_SIZE_MAX}
            onClick={() => {
              onFontSize(fontSize + 1)
            }}
          >
            +
          </button>
          <span className="stepper-unit">px</span>
        </span>
      </div>
    </section>
  )
}

function ModelSection({ language, status, busy, onSaveCredential, onClearCredential, onRefresh }: SettingsDialogProps) {
  const t = (key: MessageKey) => translate(language, key)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<MessageKey | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const credential = status?.model.credential
  const writable = credential?.writable !== false
  const run = async (operation: () => Promise<MessageKey>) => {
    if (saving) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await operation()
      if (live.current) setMessage(result)
    } finally {
      if (live.current) setSaving(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const key = value.trim()
    if (!key || !writable) return
    void run(async () => {
      const result = await onSaveCredential(key)
      if (result === 'credentialSaved' && live.current) setValue('')
      return result
    })
  }
  const source: MessageKey | null = !credential?.configured
    ? null
    : credential.source === 'env'
      ? 'credentialSourceEnv'
      : credential.source === 'file'
        ? 'credentialSourceFile'
        : 'credentialSourceOther'
  return (
    <section className="settings-section" aria-label={t('settingsModel')}>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-title">{t('modelProvider')}</span>
          <span className="settings-row-desc">{t('modelHint')}</span>
        </span>
        <span className="settings-value">{status ? `${status.model.provider} · ${status.model.id}` : t('statusFailure')}</span>
      </div>
      <form className="settings-group" onSubmit={submit}>
        <span className="settings-group-head">
          <label className="settings-row-title" htmlFor="model-api-key">
            {t('apiKey')}
          </label>
          <span className={`state-pill ${credential?.configured ? 'ok' : 'warn'}`}>
            {t(credential?.configured ? 'credentialConfigured' : 'credentialMissing')}
          </span>
        </span>
        {source ? <span className="settings-row-desc">{t(source)}</span> : null}
        <span className="secret-row">
          <input
            id="model-api-key"
            className="settings-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={t(credential?.configured ? 'apiKeyReplace' : 'apiKeyPlaceholder')}
            disabled={!writable || saving || !status}
            onChange={(e) => {
              setValue(e.target.value)
              setMessage(null)
            }}
          />
          <button type="submit" className="button primary" disabled={!value.trim() || !writable || saving || !status}>
            {t(saving ? 'loading' : 'apiKeySave')}
          </button>
          {credential?.configured && credential.source === 'file' ? (
            <button
              type="button"
              className="button outline"
              disabled={saving || busy}
              onClick={() => void run(onClearCredential)}
            >
              {t('apiKeyClear')}
            </button>
          ) : null}
        </span>
        {message ? (
          <span className={`settings-feedback ${message === 'credentialSaved' || message === 'credentialCleared' ? 'ok' : 'error'}`} role="status">
            {t(message)}
          </span>
        ) : null}
      </form>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-title">{t('onlineCheck')}</span>
          <span className="settings-row-desc">{t('unverified')}</span>
        </span>
        <button type="button" className="button outline" disabled={busy} onClick={onRefresh}>
          <Icon name="refresh" />
          {t('refreshStatus')}
        </button>
      </div>
    </section>
  )
}

function RegistrySection({ language, status, registryOrigin, busy, onAuthorize }: SettingsDialogProps) {
  const t = (key: MessageKey) => translate(language, key)
  const authorized = status?.registry.authorization === 'authorized'
  return (
    <section className="settings-section" aria-label={t('registry')}>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-title">{t('registryAccess')}</span>
          <span className="settings-row-desc">{t('registryHint')}</span>
        </span>
        <span className={`state-pill ${authorized ? 'ok' : 'warn'}`}>{t(authorized ? 'authorized' : 'authorizationRequired')}</span>
        <button type="button" className="button outline" disabled={busy || !status} onClick={onAuthorize}>
          {t('authorize')}
        </button>
      </div>
      {registryOrigin ? (
        <div className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-title">{t('registryAddress')}</span>
          </span>
          <a className="settings-link" href={registryOrigin} target="_blank" rel="noopener noreferrer">
            {registryOrigin}
            <Icon name="external" size={14} />
          </a>
        </div>
      ) : null}
    </section>
  )
}
