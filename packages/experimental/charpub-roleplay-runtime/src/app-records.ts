/** Bounded roleplay discovery over the public Session persistence service. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type RoleplayRuntime from './index.ts'
import type { AppControllerOptions, AppStoredRecord } from './app-controller.ts'

/**
 * Read only one page of event logs, retaining unreadable entries for explicit recovery.
 * @param persistence - The owner-controlled local Session storage provider.
 * @param runtime - The existing authoritative roleplay inspector.
 * @returns The app's private, cancellable record-page reader.
 */
export function appRecordReader(persistence: Pick<SessionPersistence, 'list' | 'open'>, runtime: Pick<RoleplayRuntime, 'inspect'>): AppControllerOptions['listRecords'] {
  return async ({ limit, after, signal }) => {
    signal.throwIfAborted()
    const rows = [...await persistence.list({ signal })]
      .sort((a, b) => b.header.createdAt - a.header.createdAt || (a.header.id < b.header.id ? -1 : 1))
    const previous = after === undefined ? -1 : rows.findIndex(row => row.header.id === after)
    if (after !== undefined && previous === -1) throw new Error('roleplay_app.cursor_expired')
    const page = rows.slice(previous + 1, previous + 1 + limit)
    const records: AppStoredRecord[] = []
    for (const row of page) {
      signal.throwIfAborted()
      try {
        // A header alone does not distinguish roleplay from another Session producer.
        const handle = await persistence.open(row.header.id, 'read', { signal })
        let roleplay = false
        try { roleplay = (await handle.read()).events[0]?.type === 'roleplay/opened' }
        finally { await handle.close() }
        if (!roleplay) continue
        const projection = await runtime.inspect(row.header.id)
        signal.throwIfAborted()
        records.push({ id: row.header.id, createdAt: row.header.createdAt, projection })
      } catch (error) {
        if (signal.aborted) throw error
        // Keep local failures visible without exposing stored text through exception details.
        records.push({ id: row.header.id, createdAt: row.header.createdAt, error: 'roleplay_runtime.unreadable' })
      }
    }
    const last: SessionId | undefined = page.at(-1)?.header.id
    return { records, ...(last && previous + 1 + page.length < rows.length ? { after: last } : {}) }
  }
}
