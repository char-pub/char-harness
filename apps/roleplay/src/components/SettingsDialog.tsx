/** Settings panel in the DeepSeek Harness layout: section rail, titled sections, rows with hairline separators. */
import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppStatus } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives/src/useModalLayer.ts'
import { translate, type Language, type MessageKey } from '../i18n.ts'
import { Icon, type IconName } from './Icon.tsx'
import { ModelsSection, type ModelsOperations } from './ModelsSection.tsx'
import { PluginInventorySection, type PluginOperations } from './Plugins.tsx'

/** Interface theme preference; `system` follows the operating system. */
export type Theme = 'light' | 'dark' | 'system'
/** Content font-size bounds shared with the DeepSeek Harness Settings range. */
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 22
/** Settings sections in rail order. */
export type SettingsSection = 'general' | 'models' | 'plugins' | 'registry'

/** Local preferences and host state shown by the panel; every host change goes through an explicit operation. */
export interface SettingsDialogProps {
  language: Language
  theme: Theme
  fontSize: number
  status: AppStatus | null
  registryOrigin: string | undefined
  busy: boolean
  /** Section shown when the panel opens. */
  initialSection?: SettingsSection
  models: ModelsOperations
  plugins: PluginOperations
  onLanguage: (value: Language) => void
  onTheme: (value: Theme) => void
  onFontSize: (value: number) => void
  onAuthorize: () => void
  onClose: () => void
}

/**
 * Render the body-portaled settings panel.
 * @param props - Current preferences, host state and explicit change operations.
 * @returns The modal settings panel.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { language, onClose } = props
  const t = (key: MessageKey) => translate(language, key)
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? 'general')
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useModalLayer(panel, true, onClose)
  const sections: ReadonlyArray<[SettingsSection, IconName, MessageKey]> = [
    ['general', 'general', 'settingsGeneral'],
    ['models', 'model', 'settingsModel'],
    ['plugins', 'sliders', 'builtinPlugins'],
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
            {section === 'models' ? <ModelsSection language={language} operations={props.models} /> : null}
            {section === 'plugins' ? <PluginInventorySection language={language} operations={props.plugins} /> : null}
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
        <span className="font-size-control">
          <span className="font-stepper">
            <span className="stepper-value" aria-live="polite">{fontSize}</span>
            <span className="stepper-arrows">
              <button
                type="button"
                className="stepper-arrow"
                aria-label={t('fontSizeIncrease')}
                disabled={fontSize >= FONT_SIZE_MAX}
                onClick={() => {
                  onFontSize(fontSize + 1)
                }}
              >
                <Icon name="chevronUp" size={9} />
              </button>
              <button
                type="button"
                className="stepper-arrow"
                aria-label={t('fontSizeDecrease')}
                disabled={fontSize <= FONT_SIZE_MIN}
                onClick={() => {
                  onFontSize(fontSize - 1)
                }}
              >
                <Icon name="chevronDown" size={9} />
              </button>
            </span>
          </span>
          <span className="stepper-unit">px</span>
        </span>
      </div>
      <div className="settings-row settings-version">
        <span className="settings-row-title">{`${t('currentVersion')}${__APP_VERSION__}`}</span>
      </div>
    </section>
  )
}

function RegistrySection({ language, status, registryOrigin, busy, onAuthorize }: SettingsDialogProps) {
  const t = (key: MessageKey) => translate(language, key)
  const authorized = status?.registry.authorization === 'authorized'
  return (
    <section className="settings-section" aria-label={t('registry')}>
      <h2 className="section-title">{t('registry')}</h2>
      <p className="section-intro">{t('registryHint')}</p>
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-title">{t('registryAccess')}</span>
          <span className="settings-row-desc">{t(authorized ? 'authorized' : 'authorizationRequired')}</span>
        </span>
        <span className={`state-pill ${authorized ? 'ok' : 'warn'}`}>{t(authorized ? 'authorized' : 'notAuthorized')}</span>
        <button type="button" className="secondary-button" disabled={busy || !status} onClick={onAuthorize}>
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
