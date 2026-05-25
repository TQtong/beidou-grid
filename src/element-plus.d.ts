declare module 'element-plus' {
  import type { App, Plugin } from 'vue'

  const ElementPlus: Plugin & {
    install(app: App): void
  }

  export default ElementPlus
}
