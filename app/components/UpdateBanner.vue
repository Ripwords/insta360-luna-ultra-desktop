<script setup lang="ts">
defineProps<{ collapsed?: boolean }>();

const { phase, version, progress, errorMessage, available, check, install, dismiss } = useUpdater();

// Check once on startup, then hourly, without nagging when up to date
onMounted(() => {
  if (!available.value) return;
  void check(true);
  const timer = setInterval(() => void check(true), 60 * 60 * 1000);
  onBeforeUnmount(() => clearInterval(timer));
});

const show = computed(() => ["available", "downloading", "ready", "error"].includes(phase.value));
</script>

<template>
  <div v-if="available && show" class="w-full">
    <div v-if="collapsed" class="flex justify-center">
      <UTooltip :text="`Update ${version} available`">
        <UButton
          icon="i-lucide-arrow-up-circle"
          size="sm"
          color="primary"
          variant="soft"
          square
          @click="install"
        />
      </UTooltip>
    </div>

    <div v-else class="rounded-lg border border-default bg-elevated/60 p-2.5 text-sm">
      <template v-if="phase === 'available'">
        <p class="font-medium text-highlighted">Update available</p>
        <p class="mb-2 text-xs text-muted">Version {{ version }}</p>
        <div class="flex gap-1.5">
          <UButton label="Install" size="xs" color="primary" block @click="install" />
          <UButton label="Later" size="xs" color="neutral" variant="ghost" @click="dismiss" />
        </div>
      </template>

      <template v-else-if="phase === 'downloading'">
        <p class="mb-1.5 font-medium text-highlighted">Downloading update</p>
        <UProgress :model-value="progress" size="sm" />
      </template>

      <template v-else-if="phase === 'ready'">
        <p class="font-medium text-highlighted">Restarting to update…</p>
      </template>

      <template v-else-if="phase === 'error'">
        <p class="font-medium text-error">Update failed</p>
        <p class="mb-2 truncate text-xs text-muted">{{ errorMessage }}</p>
        <UButton label="Retry" size="xs" color="neutral" variant="outline" @click="check(false)" />
      </template>
    </div>
  </div>
</template>
