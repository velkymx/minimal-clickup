import { Agent } from 'node:https'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // Browser can't call api.clickup.com directly (CORS); dev server proxies it.
      '/clickup': {
        target: 'https://api.clickup.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/clickup/, ''),
        // Fresh connection per request: ClickUp's LB kills idle keep-alive
        // sockets, and reusing a dead one throws ECONNRESET (browser sees a
        // raw 500 from the proxy). Costs a TLS handshake, saves the session.
        agent: new Agent({ keepAlive: false }),
      },
    },
  },
})
