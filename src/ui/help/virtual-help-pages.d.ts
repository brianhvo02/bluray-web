/** The help pages converted at build time by `vite/markdown.ts`, by slug. */
declare module 'virtual:help-pages' {
  const pages: Readonly<Record<string, { readonly html: string; readonly summary: string }>>;
  export default pages;
}
