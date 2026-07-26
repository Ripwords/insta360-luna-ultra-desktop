<script setup lang="ts">
defineProps<{ collapsed?: boolean }>();

const colorMode = useColorMode();

const isDark = computed({
  get: () => colorMode.value === "dark",
  set: (value) => {
    colorMode.preference = value ? "dark" : "light";
  },
});
</script>

<template>
  <UColorModeButton v-if="collapsed" color="neutral" variant="ghost" />
  <UFieldGroup v-else class="w-full">
    <UButton
      label="Arctic"
      icon="i-lucide-sun"
      size="sm"
      block
      class="flex-1"
      :color="isDark ? 'neutral' : 'primary'"
      :variant="isDark ? 'outline' : 'solid'"
      @click="isDark = false"
    />
    <UButton
      label="Midnight"
      icon="i-lucide-moon"
      size="sm"
      block
      class="flex-1"
      :color="isDark ? 'primary' : 'neutral'"
      :variant="isDark ? 'solid' : 'outline'"
      @click="isDark = true"
    />
  </UFieldGroup>
</template>
