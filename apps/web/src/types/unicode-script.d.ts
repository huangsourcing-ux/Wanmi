declare module 'unicode-script' {
  export function isMixedScript(value: string): boolean
  export function unicodeScript(value: number | string): string | undefined
  export function unicodeScripts(value: string): Set<string>
}
