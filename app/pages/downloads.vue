<script setup lang="ts">
import { formatBytes } from "~/utils/media";
import { canWatermark } from "~/utils/watermark";

useHead({ title: "Downloads" });

const { queue, active, completed, retry, clearFinished } = useDownloads();

const hasFinished = computed(() =>
  queue.value.some((entry) => entry.status === "done" || entry.status === "error"),
);
</script>

<template>
  <UDashboardPanel id="downloads">
    <template #header>
      <UDashboardNavbar title="Downloads">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            v-if="hasFinished"
            label="Clear finished"
            color="neutral"
            variant="ghost"
            icon="i-lucide-list-x"
            @click="clearFinished"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="queue.length === 0"
        class="flex h-full flex-col items-center justify-center gap-4 text-center"
      >
        <span class="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <UIcon name="i-lucide-arrow-down-to-line" class="size-7 text-dimmed" />
        </span>
        <div class="space-y-1">
          <p class="font-medium text-highlighted">No transfers yet</p>
          <p class="max-w-xs text-sm text-muted">
            Select files in the gallery and download them to see them here.
          </p>
        </div>
        <UButton label="Open gallery" icon="i-lucide-images" to="/gallery" />
      </div>

      <div v-else class="mx-auto w-full max-w-3xl space-y-2">
        <p v-if="active.length > 0" class="pb-1 font-mono text-xs text-muted tabular-nums">
          {{ active.length }} in progress · {{ completed.length }} done
        </p>

        <div
          v-for="entry in queue"
          :key="entry.id"
          class="flex items-center gap-4 rounded-xl border border-default bg-elevated/40 p-3"
        >
          <div class="size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
            <VideoThumb
              v-if="entry.item.type === 'video'"
              :src="entry.item.srcUrl"
              :lrv="entry.item.lrvUrl"
              img-class="size-full object-cover"
            />
            <CameraImage
              v-else
              :src="entry.item.srcUrl"
              :alt="entry.item.name"
              img-class="size-full object-cover"
            />
          </div>

          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex items-center gap-2">
              <p class="truncate font-mono text-sm text-highlighted">{{ entry.item.name }}</p>
              <UBadge
                v-if="entry.watermarked && canWatermark(entry.item)"
                variant="subtle"
                size="sm"
                icon="i-lucide-stamp"
              >
                Watermarked
              </UBadge>
            </div>

            <p v-if="entry.status === 'done'" class="truncate text-xs text-muted">
              Saved to {{ entry.savedTo }} · {{ formatBytes(entry.item.size) }}
            </p>
            <p v-else-if="entry.status === 'error'" class="truncate text-xs text-error">
              {{ entry.error }}
            </p>
            <UProgress v-else :model-value="entry.progress" size="sm" class="max-w-64" />
          </div>

          <div class="shrink-0">
            <UIcon
              v-if="entry.status === 'done'"
              name="i-lucide-circle-check"
              class="size-5 text-success"
            />
            <UButton
              v-else-if="entry.status === 'error'"
              label="Retry"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-rotate-cw"
              @click="retry(entry.id)"
            />
            <span v-else class="font-mono text-xs text-muted tabular-nums"
              >{{ entry.progress }}%</span
            >
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
