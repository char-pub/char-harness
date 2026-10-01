/** Stylesheets are bundled by the browser build and have no JavaScript exports. */
declare module '*.css'
/** The browser build emits imported SVG files as fingerprinted asset URLs. */
declare module '*.svg' {
  const url: string
  export default url
}
