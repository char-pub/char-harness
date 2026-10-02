/** Stylesheets are bundled by the browser build and have no JavaScript exports. */
declare module '*.css'
/** The browser build emits imported SVG files as fingerprinted asset URLs. */
declare module '*.svg' {
  const url: string
  export default url
}
/** Package version injected by the browser build for the Settings version row. */
declare const __APP_VERSION__: string
