<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { VibeCloseButton } from '@velkymx/vibeui'
import { useLightbox } from '../composables/useLightbox'

const { lightbox, closeLightbox } = useLightbox()

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && lightbox.src) closeLightbox()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="lightbox.src" class="lightbox-overlay" @click="closeLightbox()">
      <VibeCloseButton white class="lightbox-close" @click="closeLightbox()" />
      <img
        class="lightbox-image"
        :src="lightbox.src"
        :alt="lightbox.alt"
        @click.stop
      />
      <div v-if="lightbox.alt" class="lightbox-caption">{{ lightbox.alt }}</div>
    </div>
  </Teleport>
</template>
