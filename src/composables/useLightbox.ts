import { reactive, readonly } from 'vue'

const state = reactive({ src: '', alt: '' })

/** Tiny global store for the image lightbox. Empty src = closed. */
export function useLightbox() {
  return {
    lightbox: readonly(state),
    openLightbox(src: string, alt = '') {
      state.src = src
      state.alt = alt
    },
    closeLightbox() {
      state.src = ''
      state.alt = ''
    },
  }
}
