/** Schema introspection and immutable path edits for the Harness settings forms, mirroring the Web settings schema service. */
import Schema from '@deepseek-ai/schemastery'
import type { AppJson, AppSettingsPathOp } from '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app-types'

/** Live schemastery node rehydrated from a serialized descriptor. */
export type SchemaNode = Schema

/**
 * Rehydrate one serialized `schema.toJSON()` envelope.
 * @param serialized - Descriptor schema from the host.
 * @returns The live schema node.
 */
export function rehydrate(serialized: unknown): SchemaNode {
  return new Schema(serialized as Schema)
}

/**
 * Resolve an object, dict or array node at a settings path.
 * @param root - Schema node to traverse.
 * @param path - Object keys or array indexes.
 * @returns The node, or undefined when the path leaves the schema.
 */
export function nodeAt(root: SchemaNode, path: readonly string[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = root
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object') node = (node.dict as Record<string, SchemaNode> | undefined)?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner as SchemaNode | undefined
    else return undefined
  }
  return node
}

/**
 * Read a nested value by object keys or array indexes.
 * @param value - Value to traverse.
 * @param path - Keys from the section root.
 * @returns The value, or undefined when absent.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)]
    else if (typeof current === 'object' && current !== null) current = (current as Record<string, unknown>)[key]
    else return undefined
  }
  return current
}

/**
 * Whether the final key of a path exists, independently of its value.
 * @param value - Value to traverse.
 * @param path - Keys from the section root.
 * @returns True when the key is present.
 */
export function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  const parent = getPath(value, path.slice(0, -1))
  return typeof parent === 'object' && parent !== null && Object.hasOwn(parent, path[path.length - 1] as string)
}

/**
 * The minimal set/unset ops carrying `after` over `before` for the keys of one subtree.
 * Only keys present on either side produce an op, so fields outside the edited card are never restated.
 * @param base - Path of the edited subtree inside the user section.
 * @param before - Subtree as loaded, or undefined when new.
 * @param after - Subtree as edited.
 * @returns Ordered ops; empty when nothing changed.
 */
export function pathOps(base: readonly string[], before: unknown, after: Record<string, unknown>): AppSettingsPathOp[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before) ? before as Record<string, unknown> : {}
  const ops: AppSettingsPathOp[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value: value as AppJson })
  }
  for (const key of Object.keys(previous)) if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  return ops
}
