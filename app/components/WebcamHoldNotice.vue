<script setup lang="ts">
const emit = defineEmits<{ turnOff: [] }>();
</script>

<template>
  <!-- shrink-0: the dashboard body is a scrolling flex column, and a tall
       gallery would otherwise squeeze the alert's padding away.
       Text and action stay neutral: the subtle variant's amber text on its
       amber tint falls well short of WCAG AA. Only the icon carries the colour. -->
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-webcam"
    title="Webcam mode is on. The camera can't stream and transfer files at the same time."
    :actions="[
      {
        label: 'Turn off webcam mode',
        color: 'neutral',
        variant: 'outline',
        size: 'md',
        onClick: () => emit('turnOff'),
      },
    ]"
    orientation="horizontal"
    :ui="{ title: 'text-highlighted', icon: 'text-warning' }"
    class="shrink-0 rounded-[22px]"
  />
</template>
