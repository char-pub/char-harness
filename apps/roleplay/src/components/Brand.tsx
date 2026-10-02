/** char.pub identity from char-pub/brand-assets; the open C follows the current ink, the three nodes keep brand color. */
import wordmarkLight from '../brand/wordmark-light.svg'
import wordmarkDark from '../brand/wordmark-dark.svg'

/**
 * Render the char.pub mark. Brand guidance sets a 24 px minimum display size.
 * @param props - Rendered square size in CSS pixels.
 * @returns A decorative vector mark.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="40 50 390 410" aria-hidden="true">
      <path
        fill="currentColor"
        d="M352 91 C290 58 220 59 165 81 C91 110 48 171 48 256 C48 341 91 402 165 431 C218 452 279 446 330 420 Q338 416 334 408 L306 354 Q302 346 293 352 C256 373 216 373 183 359 C143 342 120 304 120 256 C120 208 143 170 183 153 C220 137 262 140 300 163 Q309 168 315 159 L357 105 Q363 96 352 91 Z"
      />
      <path
        d="M292 256 C322 249 338 232 367 202 M292 256 C325 263 344 282 367 310"
        fill="none"
        stroke="currentColor"
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="237" cy="256" r="31" fill="#FF6B3D" />
      <circle cx="386" cy="194" r="32" fill="#8B5CF6" />
      <circle cx="386" cy="318" r="32" fill="#2563EB" />
    </svg>
  )
}

/**
 * Render the outlined char.pub wordmark for the active theme.
 * @param props - Accessible product name.
 * @returns Light and dark wordmark images; CSS shows the one matching the page theme.
 */
export function BrandWordmark({ label }: { label: string }) {
  return (
    <span className="brand-wordmark" role="img" aria-label={label}>
      <img className="wordmark-light" src={wordmarkLight} alt="" />
      <img className="wordmark-dark" src={wordmarkDark} alt="" />
    </span>
  )
}
