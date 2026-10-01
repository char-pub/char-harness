/** Inject public local-page configuration into the compiled browser entry, never model or OAuth credentials. */
export interface AppPageConfiguration { nonce: string; registryOrigin: string }

/**
 * Bind the compiled browser page to its current profile instance.
 * @param template - Vite-built HTML containing the single bootstrap marker.
 * @param configuration - Public page nonce and configured Registry origin.
 * @returns HTML with inert, escaped JSON bootstrap data and external same-origin assets.
 */
export function appHTML(template: string, configuration: AppPageConfiguration): string {
  const marker = '<!--CHARPUB_BOOTSTRAP-->'
  if (template.split(marker).length !== 2) throw new Error('roleplay_app.assets_invalid')
  const data = JSON.stringify(configuration).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  return template.replace(marker, `<script id="charpub-bootstrap" type="application/json">${data}</script>`)
}
