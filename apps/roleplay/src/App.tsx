/** Local story client. Authoritative work, conversation and operation results come from the profile API. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  AppLaunchReview,
  AppSessionRecord,
  AppSessionSnapshot,
  AppStartRequest,
  AppStatus,
  AppTurnRequest,
  AppTurnResult,
} from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'
import {
  createRoleplayApi,
  readBootstrap,
  RoleplayApiError,
  type RoleplayApi,
  type RoleplayBootstrap,
  type PreviewReview,
} from './api.ts'
import { translate, type Language, type MessageKey } from './i18n.ts'
import { Icon } from './components/Icon.tsx'
import { Modal } from './components/Modal.tsx'
import { BrandMark, BrandWordmark } from './components/Brand.tsx'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, SettingsDialog, type Theme } from './components/SettingsDialog.tsx'
import { Bindings, enteredBindings } from './components/Bindings.tsx'
import { ReviewPanel } from './components/ReviewPanel.tsx'

type Pending = { request: AppTurnRequest; phase: 'sending' | 'unknown' | 'not_found' }
type ErrorInfo = { code: string; message: MessageKey }
type Busy = 'bootstrap' | 'list' | 'review' | 'start' | 'resume' | 'send' | 'authorize' | 'inspect' | 'export' | null
const DRAFTS = 'charpub-roleplay-reply-drafts',
  REQUESTS = 'charpub-roleplay-pending-requests'
function readText(key: string, local = false): string | null {
  try {
    return (local ? localStorage : sessionStorage).getItem(key)
  } catch (error) {
    void error
    return null /* Storage can be unavailable in embedded/private browser contexts. */
  }
}
function saveText(key: string, value: string | null, local = false) {
  try {
    const storage = local ? localStorage : sessionStorage
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch (error) {
    void error /* In-memory drafts remain usable when browser storage is unavailable. */
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function storedObject(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readText(key) ?? '{}')
    return object(value) ? value : {}
  } catch (error) {
    void error
    return {} /* A damaged UI cache grants no operation or authority. */
  }
}
function storedDrafts(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(storedObject(DRAFTS)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
function storedRequests(): Record<string, Pending> {
  const result: Record<string, Pending> = {}
  for (const [record, value] of Object.entries(storedObject(REQUESTS))) {
    if (!object(value) || !object(value.request)) continue
    const request = value.request
    if (
      typeof request.session !== 'string' ||
      typeof request.request_id !== 'string' ||
      typeof request.text !== 'string'
    )
      continue
    result[record] = {
      request: {
        session: request.session,
        request_id: request.request_id,
        text: request.text,
        ...(request.recover_interrupted === true ? { recover_interrupted: true as const } : {}),
      },
      phase: 'unknown',
    }
  }
  return result
}
/** First matching machine-code pattern selects the user-facing explanation. */
const ERROR_MESSAGES: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/credential_read_only/, 'credentialReadOnly'],
  [/stale_session/, 'stale'],
  [/http_401|authorization_changed|authorization_required|unauthorized/, 'unauthorized'],
  [/http_403/, 'forbidden'],
  [/expired/, 'expired'],
  [/credential|provider|model_unavailable|api_key/, 'modelUnavailable'],
  [/unsupported|story_required|content_required/, 'unsupported'],
  [/connection_lost|bootstrap/, 'unavailable'],
  [/invalid|unknown|mismatch/, 'invalid'],
]
function errorInfo(error: unknown): ErrorInfo {
  const code = error instanceof RoleplayApiError ? error.code : 'roleplay_app.operation_failed'
  const message = ERROR_MESSAGES.find(([pattern]) => pattern.test(code))?.[1] ?? 'operationFailed'
  return { code, message }
}
function initialLanguage(): Language {
  const saved = readText('charpub-roleplay-language', true)
  return saved === 'en' || saved === 'zh' ? saved : navigator.language.startsWith('zh') ? 'zh' : 'en'
}
function initialTheme(): Theme {
  const saved = readText('charpub-roleplay-theme', true)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}
function initialFontSize(): number {
  const saved = Number(readText('charpub-roleplay-font-size', true))
  return Number.isInteger(saved) && saved >= FONT_SIZE_MIN && saved <= FONT_SIZE_MAX ? saved : 14
}
function incomingLaunch(): string {
  const intent = new URLSearchParams(location.hash.slice(1)).get('launch')
  if (intent !== null) {
    saveText('roleplay-launch', intent)
    history.replaceState(null, '', location.pathname + location.search)
    return intent
  }
  return readText('roleplay-launch') ?? ''
}

/**
 * Render the three-pane player using only same-origin API data.
 * @param props - Optional transport/bootstrap injection for owner-local interaction tests.
 * @returns The player; missing bootstrap renders an honest disconnected state.
 */
export function App(props: { api?: RoleplayApi; bootstrap?: RoleplayBootstrap }) {
  const [boot] = useState(() => {
    try {
      const bootstrap = props.bootstrap ?? readBootstrap()
      return { bootstrap, api: props.api ?? createRoleplayApi(bootstrap), error: null }
    } catch (error) {
      return { bootstrap: null, api: null, error: errorInfo(error) }
    }
  })
  const api = boot.api
  const [language, setLanguage] = useState<Language>(initialLanguage),
    [theme, setTheme] = useState<Theme>(initialTheme),
    [fontSize, setFontSize] = useState(initialFontSize)
  const t = useCallback((key: MessageKey) => translate(language, key), [language])
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [status, setStatus] = useState<AppStatus | null>(null),
    [statusError, setStatusError] = useState<ErrorInfo | null>(boot.error)
  const [records, setRecords] = useState<AppSessionRecord[]>([]),
    [cursor, setCursor] = useState<string | undefined>()
  const [listLoading, setListLoading] = useState(false),
    [listError, setListError] = useState<ErrorInfo | null>(null)
  const [snapshot, setSnapshot] = useState<AppSessionSnapshot | null>(null),
    [review, setReview] = useState<AppLaunchReview | null>(null)
  const [mode, setMode] = useState<'welcome' | 'review' | 'session'>('welcome')
  const [launch, setLaunch] = useState(incomingLaunch)
  const [busy, setBusy] = useState<Busy>(null),
    [error, setError] = useState<ErrorInfo | null>(null),
    [notice, setNotice] = useState<MessageKey | null>(null)
  const [drafts, setDrafts] = useState(storedDrafts),
    [pending, setPending] = useState(storedRequests)
  const [settings, setSettings] = useState(false),
    [exportOpen, setExportOpen] = useState(false)
  const [recoveryRecord, setRecoveryRecord] = useState<string | null>(null)
  const navigation = useRef(0)
  const [leftOpen, setLeftOpen] = useState(false),
    [rightOpen, setRightOpen] = useState(false)
  const live = useRef(true),
    busyRef = useRef<Busy>(null),
    snapshotRef = useRef(snapshot),
    draftsRef = useRef(drafts),
    pendingRef = useRef(pending)
  snapshotRef.current = snapshot
  draftsRef.current = drafts
  pendingRef.current = pending
  const leftPanel = useRef<HTMLElement>(null),
    rightPanel = useRef<HTMLElement>(null)
  const scrollEnd = useRef<HTMLDivElement>(null),
    reply = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    // The DeepSeek Harness token sheets select the dark palette from this body attribute.
    const dark = theme === 'system' ? systemDark : theme === 'dark'
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    saveText('charpub-roleplay-theme', theme, true)
  }, [theme, systemDark])
  useEffect(() => {
    document.body.style.setProperty('--dsh-content-font-size', `${fontSize}px`)
    saveText('charpub-roleplay-font-size', String(fontSize), true)
  }, [fontSize])
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    saveText('charpub-roleplay-language', language, true)
  }, [language])
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const change = () => {
      setSystemDark(media.matches)
    }
    media.addEventListener('change', change)
    return () => {
      media.removeEventListener('change', change)
    }
  }, [])
  useEffect(() => {
    saveText(DRAFTS, JSON.stringify(drafts))
  }, [drafts])
  useEffect(() => {
    saveText(REQUESTS, JSON.stringify(pending))
  }, [pending])
  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [snapshot?.record, snapshot?.history.length])
  useEffect(() => {
    const panel = leftOpen ? leftPanel.current : rightOpen ? rightPanel.current : null
    if (!panel) return
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary',
      ),
    ]
    controls()[0]?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setLeftOpen(false)
        setRightOpen(false)
      }
      if (event.key !== 'Tab') return
      const buttons = controls(),
        first = buttons[0],
        last = buttons.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    panel.addEventListener('keydown', keyboard)
    return () => {
      panel.removeEventListener('keydown', keyboard)
      prior?.focus()
    }
  }, [leftOpen, rightOpen])
  const begin = (kind: Exclude<Busy, null>) => {
    if (busyRef.current) return false
    busyRef.current = kind
    setBusy(kind)
    setError(null)
    setNotice(null)
    return true
  }
  const end = (kind: Exclude<Busy, null>) => {
    if (live.current && busyRef.current === kind) {
      busyRef.current = null
      setBusy(null)
    }
  }
  const acceptSnapshot = (value: AppSessionSnapshot) => {
    setRecoveryRecord(null)
    snapshotRef.current = value
    setSnapshot(value)
    setMode('session')
    setReview(null)
    setLeftOpen(false)
    setRightOpen(false)
  }
  const updatePending = (record: string, value: Pending | null) => {
    setPending((previous) => {
      const next = value
        ? { ...previous, [record]: value }
        : Object.fromEntries(Object.entries(previous).filter(([key]) => key !== record))
      pendingRef.current = next
      return next
    })
  }
  const loadRecords = useCallback(
    async (next?: string, owned = false) => {
      if (!api || (!owned && !begin('list'))) return
      setListLoading(true)
      setListError(null)
      try {
        const result = await api.sessions(next)
        if (!live.current) return
        setRecords(previous =>
          next
            ? [...previous, ...result.items.filter(item => !previous.some(prior => prior.record === item.record))]
            : result.items,
        )
        setCursor(result.next_cursor)
      } catch (cause) {
        if (live.current) setListError(errorInfo(cause))
      } finally {
        if (live.current) setListLoading(false)
        if (!owned) end('list')
      }
    },
    [api],
  )
  const refreshStatus = useCallback(async () => {
    if (!api) return
    try {
      const result = await api.status()
      if (live.current) {
        setStatus(result)
        setStatusError(null)
      }
      return result
    } catch (cause) {
      if (live.current) setStatusError(errorInfo(cause))
      return undefined
    }
  }, [api])
  const reviewLaunch = async (text: string) => {
    if (!api || !text.trim() || !begin('review')) return
    setMode('review')
    setReview(null)
    try {
      const value: unknown = JSON.parse(text)
      const result = await api.review(value)
      if (live.current) {
        setReview(result)
        saveText('roleplay-launch', text)
      }
    } catch (cause) {
      if (live.current) setError(errorInfo(cause))
    } finally {
      end('review')
      void refreshStatus()
    }
  }
  useEffect(() => {
    if (!api) return
    let abandoned = false
    const stillActive = () => !abandoned && live.current
    const initialNavigation = navigation.current
    if (!begin('bootstrap')) return
    void (async () => {
      const current = await refreshStatus()
      await loadRecords(undefined, true)
      end('bootstrap')
      if (!stillActive() || navigation.current !== initialNavigation) return
      if (launch.trim()) {
        if (current?.registry.authorization === 'authorized') await reviewLaunch(launch)
        return
      }
      if (current?.current_session && begin('resume')) {
        try {
          const active = await api.session(current.current_session)
          if (stillActive()) acceptSnapshot(active)
        } catch (cause) {
          if (stillActive()) setError(errorInfo(cause))
        } finally {
          end('resume')
        }
      }
    })()
    return () => {
      abandoned = true
    }
    // One bootstrap per mounted local app. Subsequent work choices are explicit actions.
  }, [api])
  const authorize = async () => {
    if (!api || !begin('authorize')) return
    try {
      if (launch.trim()) saveText('roleplay-launch', launch)
      const result = await api.authorize()
      if (live.current) location.assign(result.authorizationURL)
    } catch (cause) {
      if (live.current) setError(errorInfo(cause))
    } finally {
      end('authorize')
    }
  }
  const start = async (input: AppStartRequest) => {
    navigation.current++
    if (!api || !begin('start')) return
    try {
      const result = await api.start(input)
      if (live.current) {
        acceptSnapshot(result)
        saveText('roleplay-launch', null)
        setLaunch('')
        await loadRecords(undefined, true)
      }
    } catch (cause) {
      if (live.current) {
        if (!(cause instanceof RoleplayApiError) || cause.unknownOutcome) {
          setReview(null)
          setMode('welcome')
          setNotice('startUnknown')
          await loadRecords(undefined, true)
        }
        setError(errorInfo(cause))
      }
    } finally {
      end('start')
      void refreshStatus()
    }
  }
  const resume = async (record: string) => {
    navigation.current++
    if (!api || !begin('resume')) return
    try {
      const result = await api.resume(record)
      if (live.current) {
        acceptSnapshot(result)
        saveText('roleplay-launch', null)
        setLaunch('')
        await loadRecords(undefined, true)
      }
    } catch (cause) {
      if (live.current) setError(errorInfo(cause))
    } finally {
      end('resume')
      void refreshStatus()
    }
  }
  const settled = async (record: string, input: AppTurnRequest, result: AppTurnResult) => {
    updatePending(record, null)
    if (snapshotRef.current?.record === record) {
      snapshotRef.current = result.snapshot
      setSnapshot(result.snapshot)
    }
    if (result.status === 'success') {
      setDrafts(previous => (previous[record] === input.text ? { ...previous, [record]: '' } : previous))
      setNotice(null)
    } else {
      setNotice(result.status === 'cancelled' ? 'cancelled' : 'failed')
      if (result.error_code) setError(errorInfo(new RoleplayApiError(result.error_code)))
    }
    await loadRecords(undefined, true)
  }
  const dispatchTurn = async (record: string, input: AppTurnRequest) => {
    if (!api || !begin('send')) return
    updatePending(record, { request: input, phase: 'sending' })
    try {
      const result = await api.turn(input)
      if (live.current) await settled(record, input, result)
    } catch (cause) {
      if (!live.current) return
      if (cause instanceof RoleplayApiError && !cause.unknownOutcome) {
        updatePending(record, null)
        setError(errorInfo(cause))
      } else {
        updatePending(record, { request: input, phase: 'unknown' })
        setNotice(null)
      }
    } finally {
      end('send')
      void refreshStatus()
    }
  }
  const send = (event?: FormEvent) => {
    event?.preventDefault()
    const active = snapshotRef.current
    if (
      !active ||
      (!active.can_continue && !(active.interrupted && recoveryRecord === active.record)) ||
      active.stopped ||
      busyRef.current ||
      pendingRef.current[active.record]
    )
      return
    const text = draftsRef.current[active.record] ?? ''
    if (!text.trim()) return
    void dispatchTurn(active.record, {
      session: active.session,
      request_id: randomUUID(),
      text,
      ...(active.interrupted && recoveryRecord === active.record ? { recover_interrupted: true as const } : {}),
    })
  }
  const checkRequest = async () => {
    const active = snapshotRef.current,
      operation = active ? pendingRef.current[active.record] : undefined
    if (!api || !active || !operation || !begin('inspect')) return
    const input = { ...operation.request, session: active.session }
    try {
      const result = await api.turnStatus(active.session, input.request_id)
      if (!live.current) return
      if (result.status === 'sending') {
        updatePending(active.record, { request: input, phase: 'sending' })
        setNotice('stillSending')
      } else if (result.status === 'not_found') {
        updatePending(active.record, { request: input, phase: 'not_found' })
        setSnapshot(result.snapshot)
        snapshotRef.current = result.snapshot
      } else await settled(active.record, input, result)
    } catch (cause) {
      if (live.current) setError(errorInfo(cause))
    } finally {
      end('inspect')
    }
  }
  const cancel = async () => {
    if (!api) return
    const active = snapshotRef.current,
      operation = active ? pendingRef.current[active.record] : undefined
    try {
      await api.cancel(
        busyRef.current !== 'review' && busyRef.current !== 'start' && operation && active
          ? { session: active.session, request_id: operation.request.request_id }
          : {},
      )
      if (live.current) setNotice('cancelRequested')
    } catch (cause) {
      if (live.current) setError(errorInfo(cause))
    }
  }
  const writeCredential = async (operation: () => Promise<AppStatus['model']['credential']>, done: MessageKey) => {
    try {
      const credential = await operation()
      if (live.current) setStatus(previous => (previous ? { ...previous, model: { ...previous.model, credential } } : previous))
      return done
    } catch (cause) {
      return errorInfo(cause).message
    }
  }
  const currentPending = snapshot ? pending[snapshot.record] : undefined
  const registryOrigin = status?.registry.origin ?? boot.bootstrap?.registryOrigin
  const date = (value: string) => {
    const d = new Date(value)
    return Number.isNaN(d.valueOf())
      ? ''
      : new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d)
  }
  const newStory = () => {
    if (busyRef.current) return
    navigation.current++
    setMode('welcome')
    setReview(null)
    setLaunch('')
    saveText('roleplay-launch', null)
    setError(null)
    setNotice(null)
    setLeftOpen(false)
  }
  const canWrite =
    !!snapshot &&
    !snapshot.stopped &&
    (snapshot.can_continue || (snapshot.interrupted && recoveryRecord === snapshot.record))
  const detailView = snapshot && mode === 'session' ? snapshot : null
  return (
    <div className="app-frame">
      {leftOpen || rightOpen ? (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label={t('close')}
          onClick={() => {
            setLeftOpen(false)
            setRightOpen(false)
          }}
        />
      ) : null}
      <aside ref={leftPanel} className={`sidebar ${leftOpen ? 'is-open' : ''}`} aria-label={t('sessions')}>
        <div className="sidebar-logo">
          <span className="sidebar-brand">
            <BrandMark size={24} />
            <BrandWordmark label={t('brand')} />
            <span className="runtime-badge">{t('runtimeBadge')}</span>
          </span>
          <button
            type="button"
            className="icon-button drawer-close"
            aria-label={t('close')}
            onClick={() => {
              setLeftOpen(false)
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <button type="button" className="new-session" disabled={!!busy} onClick={newStory}>
          <Icon name="newStory" />
          <span>{t('newStory')}</span>
        </button>
        <div className="sidebar-section">
          <span>{t('sessions')}</span>
          <button
            type="button"
            className="icon-button small"
            disabled={listLoading || !!busy}
            aria-label={t('retry')}
            onClick={() => void loadRecords()}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <nav className="session-list" aria-label={t('sessions')}>
          {listLoading && !records.length ? (
            <p className="sidebar-message" role="status">
              {t('loadingSessions')}
            </p>
          ) : null}
          {!listLoading && !records.length && !listError ? (
            <div className="sidebar-empty">
              <strong>{t('noSessions')}</strong>
              <p>{t('noSessionsHint')}</p>
            </div>
          ) : null}
          {records.map(record => (
            <button
              type="button"
              key={record.record}
              className={`session-row ${snapshot?.record === record.record && mode === 'session' ? 'active' : ''}`}
              aria-current={snapshot?.record === record.record && mode === 'session' ? 'true' : undefined}
              disabled={!!busy}
              onClick={() => void resume(record.record)}
            >
              <span className="session-title">{record.work?.title || t('unnamed')}</span>
              <span className={`session-meta state-${record.state}`}>
                {date(record.created_at)} · {t(record.state)}
              </span>
            </button>
          ))}
          {listError ? (
            <div className="sidebar-message">
              <p>{t(listError.message)}</p>
              <button type="button" className="text-button" onClick={() => void loadRecords()}>
                {t('retry')}
              </button>
            </div>
          ) : null}
          {cursor ? (
            <button
              type="button"
              className="text-button load-more"
              disabled={listLoading || !!busy}
              onClick={() => void loadRecords(cursor)}
            >
              {t(listLoading ? 'loading' : 'more')}
            </button>
          ) : null}
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className="settings-trigger"
            onClick={() => {
              setSettings(true)
            }}
          >
            <Icon name="settings" />
            <span>{t('connection')}</span>
            {status && !status.model.credential.configured ? (
              <span className="state-dot warn" aria-label={t('credentialMissing')} />
            ) : null}
          </button>
        </div>
      </aside>
      <main className="center">
        <header className="center-header">
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label={t('sessionPanel')}
            onClick={() => {
              setLeftOpen(true)
            }}
          >
            <Icon name="menu" />
          </button>
          <div className="header-title">
            <strong>
              {mode === 'session' && snapshot
                ? snapshot.work.title
                : mode === 'review' && review
                  ? review.title
                  : t('newStory')}
            </strong>
            {mode === 'session' && snapshot ? <small>{snapshot.scene?.title ?? t('noScene')}</small> : null}
          </div>
          {snapshot && mode !== 'session' ? (
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                setMode('session')
              }}
            >
              {t('back')}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label={t('connection')}
            onClick={() => {
              setSettings(true)
            }}
          >
            <Icon name="settings" />
          </button>
          {detailView ? (
            <button
              type="button"
              className="icon-button details-toggle"
              aria-label={t('detailsPanel')}
              onClick={() => {
                setRightOpen(true)
              }}
            >
              <Icon name="info" />
            </button>
          ) : null}
        </header>
        <div className="banners">
          {error || statusError ? (
            <ErrorBanner
              value={error ?? statusError}
              language={language}
              onAuthorize={() => void authorize()}
              onRetry={() => {
                if (mode === 'review' && launch.trim()) void reviewLaunch(launch)
                else void refreshStatus()
              }}
              busy={!!busy}
            />
          ) : null}
          {status?.registry.authorization === 'required' ? (
            <div className="banner">
              <Icon name="info" />
              <p>{t(launch.trim() ? 'authorizeLaunch' : 'authorizationRequired')}</p>
              <button type="button" className="button outline small" disabled={!!busy} onClick={() => void authorize()}>
                {t('authorize')}
              </button>
            </div>
          ) : null}
          {status && !status.model.credential.configured ? (
            <div className="banner">
              <Icon name="model" />
              <p>{t('credentialMissingBanner')}</p>
              <button
                type="button"
                className="button outline small"
                onClick={() => {
                  setSettings(true)
                }}
              >
                {t('connection')}
              </button>
            </div>
          ) : null}
          {notice ? (
            <div className="banner subtle" role="status">
              {t(notice)}
            </div>
          ) : null}
        </div>
        <div className="center-scroll">
          {busy === 'bootstrap' || busy === 'review' || busy === 'resume' ? (
            <div className="loading-page" role="status">
              <span className="spinner" />
              <p>{t(busy === 'bootstrap' ? 'loading' : busy === 'review' ? 'reviewLoading' : 'loadingSession')}</p>
              {busy === 'review' ? (
                <button type="button" className="text-button" onClick={() => void cancel()}>
                  {t('cancel')}
                </button>
              ) : null}
            </div>
          ) : null}
          {mode === 'welcome' && busy !== 'resume' && busy !== 'bootstrap' ? (
            <section className="welcome">
              <BrandMark size={56} />
              <h1>{t('welcomeTitle')}</h1>
              <p className="welcome-intro">{t('welcomeIntro')}</p>
              {registryOrigin ? (
                <a className="button primary large" href={registryOrigin} target="_blank" rel="noopener noreferrer">
                  {t('openRegistry')}
                  <Icon name="external" />
                </a>
              ) : (
                <button
                  type="button"
                  className="button outline"
                  onClick={() => {
                    location.reload()
                  }}
                >
                  {t('retry')}
                </button>
              )}
              <ol className="welcome-steps">
                {(
                  [
                    ['welcomeStepOne', 'welcomeStepOneBody'],
                    ['welcomeStepTwo', 'welcomeStepTwoBody'],
                    ['welcomeStepThree', 'welcomeStepThreeBody'],
                  ] as const
                ).map(([title, body], index) => (
                  <li className="welcome-step" key={title}>
                    <span className="step-number">{index + 1}</span>
                    <div>
                      <h2>{t(title)}</h2>
                      <p>{t(body)}</p>
                      {index === 1 ? <code>{location.origin}/</code> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {mode === 'review' && review && busy !== 'review' ? (
            <ReviewPanel
              key={review.review}
              review={review}
              language={language}
              busy={!!busy}
              onStart={input => void start(input)}
            />
          ) : null}
          {mode === 'session' && snapshot && busy !== 'resume' ? (
            <section className="conversation" aria-label={snapshot.work.title}>
              <div className="scene-marker">
                <span>{snapshot.scene?.title ?? t('noScene')}</span>
              </div>
              {!snapshot.history.length ? <p className="empty-conversation">{t('noMessages')}</p> : null}
              {snapshot.history.map((message, index) => {
                const person =
                  message.role === 'user' ? undefined : snapshot.participants.find(item => item.key === message.speaker)
                return (
                  <article
                    key={`${index}:${message.role}`}
                    className={`message ${message.role === 'user' ? 'from-user' : person ? 'from-character' : 'from-story'}`}
                  >
                    <div className="message-name">{message.role === 'user' ? t('you') : (person?.name ?? t('storyVoice'))}</div>
                    <div className="message-text">{message.text}</div>
                  </article>
                )
              })}
              {currentPending?.phase === 'sending' ? (
                <div className="writing-indicator" role="status">
                  <span className="pending-dot" />
                  <span>{t('sending')}</span>
                </div>
              ) : null}
              <div ref={scrollEnd} />
            </section>
          ) : null}
          {mode !== 'session' ? (
            <details className="advanced launch-advanced">
              <summary>{t('advanced')}</summary>
              <p>{t('launchHint')}</p>
              <label>
                {t('launchLabel')}
                <textarea
                  rows={4}
                  value={launch}
                  disabled={!!busy}
                  onChange={(e) => {
                    navigation.current++
                    setLaunch(e.target.value)
                    setReview(null)
                    setMode('welcome')
                    saveText('roleplay-launch', null)
                  }}
                />
              </label>
              <button
                type="button"
                className="button outline"
                disabled={!launch.trim() || !!busy || !api}
                onClick={() => void reviewLaunch(launch)}
              >
                {t('reviewVersion')}
              </button>
            </details>
          ) : null}
        </div>
        {mode === 'session' && snapshot ? (
          <div className="composer-dock">
            {currentPending && currentPending.phase !== 'sending' ? (
              <div className="composer-notice" role="status">
                <Icon name="alert" />
                <div>
                  <strong>{t('unknownTitle')}</strong>
                  <p>{t(currentPending.phase === 'not_found' ? 'notFound' : 'unknownBody')}</p>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button outline small"
                      disabled={!!busy}
                      onClick={() => void checkRequest()}
                    >
                      {t('checkRequest')}
                    </button>
                    {currentPending.phase === 'not_found' ? (
                      <button
                        type="button"
                        className="button outline small"
                        disabled={!!busy}
                        onClick={() =>
                          void dispatchTurn(snapshot.record, { ...currentPending.request, session: snapshot.session })
                        }
                      >
                        {t('resend')}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {snapshot.interrupted && !snapshot.stopped ? (
              <div className="composer-notice">
                <Icon name="alert" />
                <div>
                  <strong>{t('interruptedTitle')}</strong>
                  <p>{t('interruptedBody')}</p>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={recoveryRecord === snapshot.record}
                      disabled={!!busy || !!currentPending}
                      onChange={(e) => {
                        setRecoveryRecord(e.target.checked ? snapshot.record : null)
                      }}
                    />
                    <span>{t('recoverInterrupted')}</span>
                  </label>
                </div>
              </div>
            ) : null}
            {snapshot.stopped || (!snapshot.can_continue && !snapshot.interrupted) ? (
              <p className="ended-notice">{t(snapshot.stopped ? 'endNotice' : 'cannotContinue')}</p>
            ) : null}
            <form className="composer" onSubmit={send}>
              <label className="sr-only" htmlFor="story-reply">
                {t('replyLabel')}
              </label>
              <textarea
                id="story-reply"
                ref={reply}
                rows={2}
                maxLength={100000}
                value={drafts[snapshot.record] ?? ''}
                placeholder={t('replyPlaceholder')}
                disabled={!canWrite}
                onChange={(e) => {
                  const value = e.target.value
                  setDrafts(previous => ({ ...previous, [snapshot.record]: value }))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <div className="composer-footer">
                <span className="composer-hint">{t('enterHint')}</span>
                {currentPending?.phase === 'sending' ? (
                  <div className="button-row">
                    {busy !== 'send' ? (
                      <button
                        type="button"
                        className="button ghost small"
                        disabled={!!busy}
                        onClick={() => void checkRequest()}
                      >
                        {t('checkRequest')}
                      </button>
                    ) : null}
                    <button type="button" className="round-button stop" aria-label={t('stop')} onClick={() => void cancel()}>
                      <Icon name="stop" size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="submit"
                    className="round-button"
                    aria-label={t('send')}
                    disabled={!!busy || !!currentPending || !canWrite || !(drafts[snapshot.record] ?? '').trim()}
                  >
                    <Icon name="send" />
                  </button>
                )}
              </div>
            </form>
          </div>
        ) : null}
      </main>
      {detailView ? (
        <aside ref={rightPanel} className={`details-panel ${rightOpen ? 'is-open' : ''}`} aria-label={t('details')}>
          <div className="details-heading">
            <h2>{t('details')}</h2>
            <button
              type="button"
              className="icon-button drawer-close"
              aria-label={t('close')}
              onClick={() => {
                setRightOpen(false)
              }}
            >
              <Icon name="close" />
            </button>
          </div>
          <StoryDetails
            snapshot={detailView}
            language={language}
            onExport={() => {
              if (!busyRef.current) setExportOpen(true)
            }}
          />
        </aside>
      ) : null}
      {settings ? (
        <SettingsDialog
          language={language}
          theme={theme}
          fontSize={fontSize}
          status={status}
          registryOrigin={registryOrigin}
          busy={!!busy || !api}
          onLanguage={setLanguage}
          onTheme={setTheme}
          onFontSize={setFontSize}
          onAuthorize={() => void authorize()}
          onRefresh={() => void refreshStatus()}
          onSaveCredential={async (value) => {
            if (!api) return 'unavailable'
            return writeCredential(() => api.saveCredential(value), 'credentialSaved')
          }}
          onClearCredential={async () => {
            if (!api) return 'unavailable'
            return writeCredential(() => api.clearCredential(), 'credentialCleared')
          }}
          onClose={() => {
            setSettings(false)
          }}
        />
      ) : null}
      {exportOpen && snapshot && api ? (
        <ExportDialog
          key={snapshot.session}
          snapshot={snapshot}
          api={api}
          language={language}
          begin={() => begin('export')}
          end={() => {
            end('export')
          }}
          onClose={() => {
            setExportOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function ErrorBanner({
  value,
  language,
  onAuthorize,
  onRetry,
  busy,
}: {
  value: ErrorInfo | null
  language: Language
  onAuthorize: () => void
  onRetry: () => void
  busy: boolean
}) {
  if (!value) return null
  const t = (key: MessageKey) => translate(language, key)
  return (
    <div className="banner error" role="alert">
      <Icon name="alert" />
      <div>
        <strong>{t('errorTitle')}</strong>
        <p>{t(value.message)}</p>
        <details>
          <summary>{t('technicalDetails')}</summary>
          <code>{value.code}</code>
        </details>
      </div>
      <button
        type="button"
        className="button outline small"
        disabled={busy}
        onClick={value.message === 'unauthorized' || value.message === 'forbidden' ? onAuthorize : onRetry}
      >
        {t(value.message === 'unauthorized' || value.message === 'forbidden' ? 'authorize' : 'retry')}
      </button>
    </div>
  )
}
function StoryDetails({
  snapshot,
  language,
  onExport,
}: {
  snapshot: AppSessionSnapshot
  language: Language
  onExport: () => void
}) {
  const t = (key: MessageKey) => translate(language, key)
  return (
    <div className="details-body">
      <section className="details-card">
        <div className="details-label">{t('scene')}</div>
        <h3>{snapshot.scene?.title ?? t('noScene')}</h3>
        {snapshot.scene?.description ? <p>{snapshot.scene.description}</p> : null}
      </section>
      <section className="details-cast">
        <div className="details-label">
          {t('cast')} <span>{snapshot.participants.length}</span>
        </div>
        {snapshot.participants.map(person => (
          <div className="cast-row" key={person.key}>
            <span className={`cast-initial ${person.present ? 'present' : ''}`}>{Array.from(person.name)[0]}</span>
            <div>
              <strong>{person.name}</strong>
              <small>
                {person.role ? `${person.role} · ` : ''}
                {t(person.present ? 'present' : 'absent')}
              </small>
              {person.goal ? <p>{person.goal}</p> : null}
            </div>
          </div>
        ))}
        {!snapshot.participants.length ? <p className="muted">{t('noCast')}</p> : null}
      </section>
      <p className="details-note">
        <Icon name="info" size={14} />
        <span>{t('noInference')}</span>
      </p>
      <details className="advanced">
        <summary>{t('technicalDetails')}</summary>
        <p>{snapshot.work.source_label}</p>
        <pre>
          {JSON.stringify(
            { source: snapshot.work.source, locale: snapshot.work.locale, limitations: snapshot.limitations },
            null,
            2,
          )}
        </pre>
      </details>
      <button type="button" className="button outline full" onClick={onExport}>
        <Icon name="external" />
        {t('exportTitle')}
      </button>
    </div>
  )
}
function ExportDialog({
  snapshot,
  api,
  language,
  onClose,
  begin,
  end,
}: {
  snapshot: AppSessionSnapshot
  api: RoleplayApi
  language: Language
  onClose: () => void
  begin: () => boolean
  end: () => void
}) {
  const t = (key: MessageKey) => translate(language, key)
  const [summary, setSummary] = useState(''),
    [bindings, setBindings] = useState<AppStartRequest['bindings']>({})
  const [review, setReview] = useState<PreviewReview | null>(null),
    [error, setError] = useState<ErrorInfo | null>(null),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false)
  const revision = useRef(0),
    active = useRef(true),
    busyRef = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const invalidate = () => {
    revision.current++
    setReview(null)
    setSaved(false)
  }
  const ready =
    summary.trim().length > 0 &&
    snapshot.late_slots.every(slot => !slot.required || !!bindings[slot.key]?.display_name.trim())
  const prepare = async () => {
    if (!ready || busyRef.current || !begin()) return
    busyRef.current = true
    const version = revision.current
    setBusy(true)
    setError(null)
    try {
      const value = await api.prepareExport({
        session: snapshot.session,
        history: [{ role: 'user', text: summary }],
        bindings: enteredBindings(bindings),
      })
      if (active.current && revision.current === version) setReview(value)
    } catch (cause) {
      if (active.current) setError(errorInfo(cause))
    } finally {
      busyRef.current = false
      end()
      if (active.current) setBusy(false)
    }
  }
  const download = async () => {
    if (!review || busyRef.current || !begin()) return
    busyRef.current = true
    const version = revision.current
    setBusy(true)
    setError(null)
    try {
      const result = await api.exportPreview({ session: snapshot.session, digest: review.digest })
      if (!active.current || revision.current !== version) return
      const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'runtime-preview.json'
      anchor.click()
      URL.revokeObjectURL(url)
      setSaved(true)
    } catch (cause) {
      if (active.current) setError(errorInfo(cause))
    } finally {
      busyRef.current = false
      end()
      if (active.current) setBusy(false)
    }
  }
  return (
    <Modal title={t('exportTitle')} closeLabel={t('close')} onClose={onClose} wide>
      <div className="export-content">
        <p>{t('exportHint')}</p>
        <label>
          {t('syntheticSummary')}
          <textarea
            value={summary}
            rows={4}
            onChange={(e) => {
              setSummary(e.target.value)
              invalidate()
            }}
          />
        </label>
        <Bindings
          slots={snapshot.late_slots}
          value={bindings}
          language={language}
          onChange={(value) => {
            setBindings(value)
            invalidate()
          }}
        />
        <button type="button" className="button outline" disabled={!ready || busy} onClick={() => void prepare()}>
          {t(busy ? 'loading' : 'previewExport')}
        </button>
        {review ? (
          <section>
            <h3>{t('exportReview')}</h3>
            <pre className="export-json">{JSON.stringify(review.payload, null, 2)}</pre>
            <button type="button" className="button primary" disabled={busy} onClick={() => void download()}>
              {t('downloadExport')}
            </button>
          </section>
        ) : null}
        {error ? (
          <p role="alert" className="error-text">
            {t(error.message)}
          </p>
        ) : null}
        {saved ? <p role="status">{t('exportSuccess')}</p> : null}
      </div>
    </Modal>
  )
}
