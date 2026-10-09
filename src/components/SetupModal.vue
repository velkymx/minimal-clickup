<script setup lang="ts">
import { ref } from 'vue'
import {
  VibeButton,
  VibeFormGroup,
  VibeFormInput,
  VibeFormSelect,
  VibeSpinner,
  type FormSelectOption,
} from '@velkymx/vibeui'
import { VibeModal, VibeAlert } from '@velkymx/vibeui'
import * as api from '../lib/clickup'
import { useChat } from '../composables/useChat'

const show = defineModel<boolean>({ required: true })

const { connect } = useChat()

const token = ref('')
const workspaceId = ref<string>('')
const workspaceOptions = ref<FormSelectOption[]>([])
const workspaceNames = ref<Record<string, string>>({})
const loading = ref(false)
const connecting = ref(false)
const error = ref('')

async function loadWorkspaces() {
  error.value = ''
  loading.value = true
  try {
    api.setToken(token.value)
    const workspaces = await api.getWorkspaces()
    workspaceOptions.value = workspaces.map((w) => ({ value: w.id, text: w.name }))
    workspaceNames.value = Object.fromEntries(workspaces.map((w) => [w.id, w.name]))
    workspaceId.value = String(workspaces[0]?.id ?? '')
    if (!workspaces.length) error.value = 'Token valid but no workspaces found.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load workspaces.'
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (!workspaceId.value) return
  error.value = ''
  connecting.value = true
  try {
    await connect(token.value, workspaceId.value, workspaceNames.value[workspaceId.value] ?? '')
    show.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Connection failed.'
  } finally {
    connecting.value = false
  }
}
</script>

<template>
  <VibeModal v-model="show" title="Connect to ClickUp" static-backdrop hide-footer centered>
    <p class="text-body-secondary small">
      Paste a personal API token (ClickUp → Settings → Apps). It is stored only in
      this browser's localStorage and sent straight to the ClickUp API.
    </p>

    <VibeAlert v-if="error" variant="danger">{{ error }}</VibeAlert>

    <VibeFormGroup label="Personal API token" required>
      <VibeFormInput
        v-model="token"
        type="password"
        placeholder="pk_…"
        autocomplete="off"
        show-toggle
      />
    </VibeFormGroup>

    <div class="d-flex gap-2 mb-3">
      <VibeButton
        variant="secondary"
        outline
        :disabled="!token.trim() || loading"
        @click="loadWorkspaces"
      >
        <VibeSpinner v-if="loading" size="sm" class="me-1" />
        Load workspaces
      </VibeButton>
    </div>

    <template v-if="workspaceOptions.length">
      <VibeFormGroup label="Workspace" required>
        <VibeFormSelect v-model="workspaceId" :options="workspaceOptions" />
      </VibeFormGroup>

      <VibeButton variant="primary" :disabled="!workspaceId || connecting" @click="submit">
        <VibeSpinner v-if="connecting" size="sm" class="me-1" />
        Connect
      </VibeButton>
    </template>
  </VibeModal>
</template>
