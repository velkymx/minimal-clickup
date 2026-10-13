import { createApp } from 'vue'
import VibeUI, { makeDomPurifySanitizer, useColorMode } from '@velkymx/vibeui'
import DOMPurify from 'dompurify'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@velkymx/vibeui/style.css'
import 'bootstrap-icons/font/bootstrap-icons.css'
import 'quill/dist/quill.snow.css'
import './style.css'
import App from './App.vue'
import { router } from './router'

const { initColorMode } = useColorMode()
initColorMode()

createApp(App)
  .use(VibeUI, {
    // VibeUI 2.x doesn't bundle its WYSIWYG peers — the composer needs both.
    wysiwyg: {
      quillLoader: () => import('quill'),
      sanitizer: makeDomPurifySanitizer(DOMPurify),
    },
  })
  .use(router)
  .mount('#app')
