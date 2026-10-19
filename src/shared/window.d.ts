export {}

declare global {
  interface Window {
    jarvis: { readonly platform: string }
    jarvisMedia: { readonly platform: string }
  }
}
