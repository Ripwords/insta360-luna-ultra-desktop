<script setup lang="ts">
const emit = defineEmits<{ turnOff: [] }>();
</script>

<template>
  <!-- shrink-0: the dashboard body is a scrolling flex column, and a tall
       gallery would otherwise squeeze the alert's padding away. -->
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-webcam"
    title="Webcam mode is on. The camera can't stream and transfer files at the same time."
    :actions="[
      {
        label: 'Turn off webcam mode',
        color: 'warning',
        variant: 'outline',
        size: 'md',
        onClick: () => emit('turnOff'),
      },
    ]"
    orientation="horizontal"
    class="shrink-0 rounded-[22px]"
  />
</template>
