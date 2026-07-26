<script setup lang="ts">
defineProps<{ count: number; deleting?: boolean }>();

const emit = defineEmits<{
  download: [];
  delete: [];
  clear: [];
}>();
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="translate-y-4 opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="translate-y-4 opacity-0"
  >
    <div
      v-if="count > 0"
      class="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-default bg-elevated/90 py-2.5 pl-4 pr-2.5 shadow-lg backdrop-blur-md"
      role="toolbar"
      aria-label="Selection actions"
    >
      <span class="whitespace-nowrap font-mono text-sm text-default tabular-nums">
        {{ count }} selected
      </span>

      <USeparator orientation="vertical" class="h-6" />

      <div class="flex items-center gap-1.5">
        <UButton
          icon="i-lucide-arrow-down-to-line"
          label="Download"
          size="sm"
          :disabled="deleting"
          @click="emit('download')"
        />
        <UButton
          icon="i-lucide-trash-2"
          label="Delete"
          size="sm"
          color="error"
          variant="soft"
          :loading="deleting"
          @click="emit('delete')"
        />
        <UButton
          icon="i-lucide-x"
          size="sm"
          color="neutral"
          variant="ghost"
          aria-label="Clear selection"
          @click="emit('clear')"
        />
      </div>
    </div>
  </Transition>
</template>
