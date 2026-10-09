<script setup lang="ts">
import { computed } from 'vue'
import { VibeBadge, VibeButton, VibeOffcanvas, useToast } from '@velkymx/vibeui'
import { apiHealth, apiLog } from '../lib/clickup'
import { useChat } from '../composables/useChat'

const show = defineModel<boolean>({ required: true })

const { state } = useChat()
const toast = useToast()

const failures = computed(() => apiLog.filter((e) => e.error).length)

function fmtTime(ts: number): string {
  return ts ? new Date(ts).toLocaleTimeString() : '—'
}

async function copyDiagnostics() {
  const report = {
    when: new Date().toISOString(),
    health: { ...apiHealth },
    state: {
      ready: state.ready,
      activeChannelId: state.activeChannelId,
      channels: state.channels.length,
      messages: state.messages.length,
      unread: { ...state.unread },
      pending: state.pending.length,
    },
    recentCalls: apiLog.slice(0, 40),
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    toast.success('Diagnostics copied — paste to share')
  } catch {
    toast.error('Copy failed')
  }
}
</script>

<template>
  <VibeOffcanvas v-model="show" title="Diagnostics" placement="end" scroll>
    <div class="debug-panel">
      <div class="mb-2">
        <strong>Connection</strong>
        <div class="small">
          Consecutive failures:
          <VibeBadge :variant="apiHealth.consecutiveFailures ? 'danger' : 'success'" pill>
            {{ apiHealth.consecutiveFailures }}
          </VibeBadge>
        </div>
        <div class="small text-body-secondary">Last OK: {{ fmtTime(apiHealth.lastOkAt) }}</div>
        <div v-if="apiHealth.lastError" class="small text-danger">
          Last error ({{ fmtTime(apiHealth.lastErrorAt) }}): {{ apiHealth.lastError }}
        </div>
      </div>

      <div class="mb-2 small text-body-secondary">
        Channels: {{ state.channels.length }} · Unread map:
        {{ Object.keys(state.unread).length }} · Pending sends: {{ state.pending.length }}
      </div>

      <VibeButton size="sm" variant="primary" class="mb-3" @click="copyDiagnostics">
        Copy diagnostics
      </VibeButton>

      <strong>API calls (last {{ apiLog.length }}, {{ failures }} failed)</strong>
      <div class="api-log">
        <div
          v-for="(entry, i) in apiLog"
          :key="i"
          class="api-log-row"
          :class="{ 'api-log-error': entry.error }"
        >
          <span class="api-log-time">{{ fmtTime(entry.ts) }}</span>
          <span class="api-log-status">{{ entry.status ?? '—' }}</span>
          <span class="api-log-ms">{{ entry.ms }}ms</span>
          <span class="api-log-path">{{ entry.method }} {{ entry.path }}</span>
          <span v-if="entry.error" class="api-log-err">{{ entry.error }}</span>
        </div>
        <div v-if="!apiLog.length" class="text-body-secondary small p-2">No calls yet.</div>
      </div>
    </div>
  </VibeOffcanvas>
</template>
