<script setup lang="ts">
import type { Member } from '../types'

/**
 * @-mention suggestions: Bootstrap dropdown markup, floated above the
 * composer (which must be `position-relative`).
 */
defineProps<{ matches: readonly Member[]; active: number }>()
const emit = defineEmits<{ pick: [member: Member] }>()
</script>

<template>
  <ul
    v-if="matches.length"
    class="dropdown-menu show position-absolute bottom-100 start-0 mb-1 shadow"
    role="listbox"
  >
    <li v-for="(member, index) in matches" :key="member.id">
      <!-- mousedown.prevent: keep focus (and the caret) in the composer -->
      <button
        type="button"
        role="option"
        :aria-selected="index === active"
        class="dropdown-item d-flex align-items-center gap-2"
        :class="{ active: index === active }"
        @mousedown.prevent="emit('pick', member)"
      >
        <img
          v-if="member.profilePicture"
          class="avatar avatar-sm"
          :src="member.profilePicture"
          :alt="member.username"
        />
        <span
          v-else
          class="avatar avatar-sm avatar-initials"
          :style="{ backgroundColor: member.color }"
        >
          {{ member.initials }}
        </span>
        {{ member.username }}
      </button>
    </li>
  </ul>
</template>
