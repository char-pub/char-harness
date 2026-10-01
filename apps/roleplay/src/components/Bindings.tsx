/** Explicit character entries; synthetic export receives a separate, initially empty value. */
import type { AppLaunchReview, AppStartRequest } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import { translate, type Language } from '../i18n.ts'

type Values = AppStartRequest['bindings']
/**
 * Render only slot metadata supplied by the current exact work.
 * @param props - Allowed slots, explicit values, update callback and interface presentation.
 * @returns Fresh role fields for the supplied slot metadata.
 */
export function Bindings({
  slots,
  value,
  onChange,
  language,
  disabled = false,
}: {
  slots: AppLaunchReview['late_slots']
  value: Values
  onChange: (next: Values) => void
  language: Language
  disabled?: boolean
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key)
  return (
    <div className="binding-list">
      {slots.map((slot, index) => {
        const current = value[slot.key] ?? {
          kind: slot.accepts.includes('persona') ? ('persona' as const) : ('character' as const),
          display_name: '',
        }
        const change = (patch: Partial<typeof current>) => {
          onChange({ ...value, [slot.key]: { ...current, ...patch } })
        }
        return (
          <fieldset className="binding-card" key={slot.key} disabled={disabled}>
            <legend>
              {slot.key === 'user' ? t('yourIdentity') : slot.hint || `${t('storyCharacter')} ${index + 1}`}{' '}
              <span className="muted">{t(slot.required ? 'bindingRequired' : 'bindingOptional')}</span>
            </legend>
            {slot.accepts.length > 1 ? (
              <label>
                {t('chooseKind')}
                <select
                  value={current.kind}
                  onChange={(e) => {
                    change({ kind: e.target.value === 'persona' ? 'persona' : 'character' })
                  }}
                >
                  {slot.accepts.map(kind => (
                    <option key={kind} value={kind}>
                      {t(kind)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              {t('characterName')}
              <input
                value={current.display_name}
                onChange={(e) => {
                  change({ display_name: e.target.value })
                }}
                autoComplete="off"
                required={slot.required}
              />
            </label>
            <label>
              {t('publicDescription')}
              <textarea
                rows={2}
                value={current.outward_description ?? ''}
                onChange={(e) => {
                  change({ outward_description: e.target.value })
                }}
              />
              <small>{t('publicHint')}</small>
            </label>
            <label>
              {t('privateDescription')}
              <textarea
                rows={2}
                value={current.description ?? ''}
                onChange={(e) => {
                  change({ description: e.target.value })
                }}
              />
              <small>{t('privateHint')}</small>
            </label>
          </fieldset>
        )
      })}
    </div>
  )
}
/**
 * Omit optional unnamed roles without copying gameplay data or altering entered text.
 * @param value - Explicit form values.
 * @returns Only entries with a nonempty display name.
 */
export function enteredBindings(value: Values): Values {
  return Object.fromEntries(Object.entries(value).filter(([, binding]) => binding.display_name.trim().length > 0))
}
