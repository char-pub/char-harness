/** Small interface symbols, independent from authored story content. */
const paths = {
  book: 'M4 4h6c1.3 0 2 .7 2 2 0-1.3.7-2 2-2h6v15h-6c-1.3 0-2 .7-2 2 0-1.3-.7-2-2-2H4z M12 6v15',
  plus: 'M12 5v14 M5 12h14',
  send: 'm4 4 17 8-17 8 4-8-4-8 M8 12h13',
  arrow: 'M5 12h14 m-5-5 5 5-5 5',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'm6 6 12 12 M6 18 18 6',
  info: 'M12 11v6 M12 7v.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M18 18A8 8 0 0 1 4 12',
  check: 'm5 12 4 4 10-10',
  alert: 'M12 3 2 21h20L12 3 M12 9v5 M12 17v.01',
  external: 'M14 3h7v7 M10 14 21 3 M10 3H4v17h17v-6',
  stop: 'M6 6h12v12H6z',
  history: 'M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2',
  chevron: 'm8 5 7 7-7 7',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
} as const
/**
 * Render a decorative icon; its surrounding action supplies the accessible name.
 * @param props - Icon identifier and optional pixel size.
 * @returns A decorative SVG without a second accessible name.
 */
export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
