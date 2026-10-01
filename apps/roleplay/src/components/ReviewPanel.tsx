/** Exact-version review is a deliberate preparation step, separate from model generation. */
import { useState } from 'react'
import type { AppLaunchReview, AppStartRequest } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { translate, type Language } from '../i18n.ts'
import { Bindings, enteredBindings } from './Bindings.tsx'
import { Icon } from './Icon.tsx'

/**
 * Review fixed content, select an opening and supply its runtime roles before starting.
 * @param props - Current server review, interface language, operation state and explicit start callback.
 * @returns The exact-version review form.
 */
export function ReviewPanel({
  review,
  language,
  busy,
  onStart,
}: {
  review: AppLaunchReview
  language: Language
  busy: boolean
  onStart: (request: AppStartRequest) => void
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key)
  const [start, setStart] = useState(review.start ?? (review.starts.length === 1 ? (review.starts[0]?.id ?? '') : ''))
  const [view, setView] = useState(review.view.mode === 'per-agent' ? review.view.for_participant : '')
  const [bindings, setBindings] = useState<AppStartRequest['bindings']>({})
  const [accepted, setAccepted] = useState(false)
  const ready =
    accepted &&
    (!review.starts.length || !!start) &&
    review.late_slots.every(slot => !slot.required || !!bindings[slot.key]?.display_name.trim()) &&
    review.support.status !== 'unsupported'
  const licenses = [...new Set(review.metadata.licenses.map(item => item.license))]
  return (
    <div className="setup-wrap">
      <div className="eyebrow">{t('setupEyebrow')}</div>
      <h1>{review.title}</h1>
      {review.work.summary ? <p className="setup-summary">{review.work.summary}</p> : null}
      <div className="meta-chips">
        <span className={`badge rating-${review.metadata.rating}`}>{t(review.metadata.rating)}</span>
        {licenses.map(license => (
          <span className="badge" key={license}>
            {license === 'LicenseRef-All-Rights-Reserved' ? t('allRightsReserved') : license}
          </span>
        ))}
      </div>
      {review.metadata.content_warnings.length ? (
        <div className="notice warm">{review.metadata.content_warnings.join(' · ')}</div>
      ) : null}
      <div className="notice subtle">
        <Icon name="info" />
        <p>{t('noInference')}</p>
      </div>
      {review.support.degraded.map(item => (
        <p className="muted small" key={item.id}>
          {item.reason}
        </p>
      ))}
      <form
        className="setup-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && !busy)
            onStart({
              review: review.review,
              bindings: enteredBindings(bindings),
              restart: review.restart_required,
              ...(start ? { start } : {}),
              ...(view ? { for_participant: view } : {}),
            })
        }}
      >
        {review.starts.length ? (
          <fieldset disabled={busy} className="opening-list">
            <legend>{t('opening')}</legend>
            {review.starts.map(option => (
              <label className={`opening-option ${start === option.id ? 'selected' : ''}`} key={option.id}>
                <input
                  type="radio"
                  name="opening"
                  value={option.id}
                  checked={start === option.id}
                  onChange={() => {
                    setStart(option.id)
                    setAccepted(false)
                  }}
                />
                <span>
                  <strong>{option.title}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                {start === option.id ? <Icon name="check" size={18} /> : null}
              </label>
            ))}
          </fieldset>
        ) : null}
        {review.view.mode === 'per-agent' ? (
          <label>
            {t('viewpoint')}
            <select
              value={view}
              disabled={busy}
              onChange={(e) => {
                setView(e.target.value)
                setAccepted(false)
              }}
            >
              {review.participants.map(item => (
                <option key={item.key} value={item.key}>
                  {item.display_name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="small muted">
            {t('viewpoint')} · {t('narrator')}
          </p>
        )}
        <Bindings
          slots={review.late_slots}
          value={bindings}
          language={language}
          disabled={busy}
          onChange={(next) => {
            setBindings(next)
            setAccepted(false)
          }}
        />
        <details className="advanced">
          <summary>{t('technicalDetails')}</summary>
          <pre>
            {JSON.stringify(
              {
                source: review.source,
                version: review.work.source_label,
                licenses: review.metadata.licenses,
                capabilities: review.capabilities,
                support: review.support,
              },
              null,
              2,
            )}
          </pre>
        </details>
        {review.restart_required ? <p className="notice warm">{t('newSessionNotice')}</p> : null}
        <label className="check-row">
          <input
            type="checkbox"
            checked={accepted}
            disabled={busy}
            onChange={(e) => {
              setAccepted(e.target.checked)
            }}
          />
          <span>{t('confirmStart')}</span>
        </label>
        <button className="button primary large" type="submit" disabled={!ready || busy}>
          {busy ? <span className="spinner" /> : <Icon name="arrow" />}
          {t(busy ? 'starting' : 'startStory')}
        </button>
      </form>
    </div>
  )
}
