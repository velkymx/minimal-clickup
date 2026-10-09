<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  VibeAlert,
  VibeFormInput,
  VibeModal,
  VibeSpinner,
} from '@velkymx/vibeui'

const show = defineModel<boolean>({ required: true })

const emit = defineEmits<{
  /** Emitted with (gifUrl, title) when the user picks a GIF. */
  pick: [url: string, title: string]
}>()

interface Gif {
  id: string
  title: string
  preview: string
  full: string
}

const API_KEY = (import.meta.env.VITE_GIPHY_API_KEY as string | undefined)?.trim()

const query = ref('')
const gifs = ref<Gif[]>([])
const loading = ref(false)
const error = ref('')

interface GiphyImage {
  url: string
}
interface GiphyGif {
  id: string
  title: string
  images: { fixed_width: GiphyImage; original: GiphyImage }
}

async function fetchGifs() {
  if (!API_KEY) return
  loading.value = true
  error.value = ''
  try {
    const q = query.value.trim()
    const endpoint = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${API_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${API_KEY}&limit=24&rating=pg-13`
    const res = await fetch(endpoint)
    if (!res.ok) throw new Error(`GIPHY error ${res.status}`)
    const json = (await res.json()) as { data: GiphyGif[] }
    gifs.value = json.data.map((g) => ({
      id: g.id,
      title: g.title || 'GIF',
      preview: g.images.fixed_width.url,
      full: g.images.original.url,
    }))
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'GIPHY request failed.'
  } finally {
    loading.value = false
  }
}

// Load trending when the modal opens.
watch(show, (open) => {
  if (open && !gifs.value.length) fetchGifs()
})

let searchDebounce: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(fetchGifs, 400)
})

function pick(gif: Gif) {
  emit('pick', gif.full, gif.title)
  show.value = false
}
</script>

<template>
  <VibeModal v-model="show" title="Send a GIF" size="lg" scrollable hide-footer>
    <template v-if="!API_KEY">
      <VibeAlert variant="warning">
        No GIPHY key configured. Add <code>VITE_GIPHY_API_KEY</code> to
        <code>.env.local</code> (free key at developers.giphy.com) and restart
        the dev server.
      </VibeAlert>
    </template>

    <template v-else>
      <VibeFormInput
        v-model="query"
        type="search"
        placeholder="Search GIPHY…"
        class="mb-3"
      />

      <VibeAlert v-if="error" variant="danger">{{ error }}</VibeAlert>

      <div v-if="loading" class="p-4 text-center">
        <VibeSpinner />
      </div>

      <div v-else class="giphy-grid">
        <button
          v-for="gif in gifs"
          :key="gif.id"
          type="button"
          class="giphy-cell"
          :title="gif.title"
          @click="pick(gif)"
        >
          <img :src="gif.preview" :alt="gif.title" loading="lazy" />
        </button>
      </div>

      <p class="text-body-secondary small mt-2 mb-0">Powered by GIPHY</p>
    </template>
  </VibeModal>
</template>
