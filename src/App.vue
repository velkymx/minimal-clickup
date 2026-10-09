<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { VibeSpinner, VibeToastHost } from '@velkymx/vibeui'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AppNavbar from './components/AppNavbar.vue'
import ChannelList from './components/ChannelList.vue'
import ChatDock from './components/ChatDock.vue'
import Lightbox from './components/Lightbox.vue'
import SetupModal from './components/SetupModal.vue'
import { useChat } from './composables/useChat'

const { state, init, setDockActive } = useChat()
const route = useRoute()
const router = useRouter()

const showSetup = ref(false)
const booting = ref(true)

onMounted(async () => {
  const restored = await init()
  booting.value = false
  if (!restored) showSetup.value = true
})

// Reopen setup when the user signs out.
watch(
  () => state.ready,
  (ready) => {
    if (!ready && !booting.value) showSetup.value = true
  },
)

// Full Slack-style chat (sidebar + channel) lives on its own page; every
// other page gets the docked Messaging tab + chat boxes instead.
const onChatPage = computed(() => route.path === '/' || route.path.startsWith('/channel/'))
watch(onChatPage, (chat) => setDockActive(!chat), { immediate: true })
</script>

<template>
  <div class="chat-app">
    <div v-if="booting" class="boot-screen">
      <VibeSpinner variant="primary" size="lg" />
      <p class="text-body-secondary mt-3">Connecting to ClickUp…</p>
    </div>

    <template v-else-if="state.ready">
      <AppNavbar />
      <div class="app-body">
        <aside v-if="onChatPage" class="sidebar">
          <ChannelList @select="(id: string) => router.push(`/channel/${id}`)" />
        </aside>
        <RouterView />
      </div>
      <ChatDock v-if="!onChatPage" />
    </template>

    <div v-else class="boot-screen">
      <p class="text-body-secondary">Not connected.</p>
    </div>

    <SetupModal v-model="showSetup" />
    <Lightbox />
    <VibeToastHost />
  </div>
</template>
