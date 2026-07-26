<script setup lang="ts">
const { info, error, isConnected, isBusy, available, connect, disconnect } = useCamera();

useHead({ title: "Connect" });

const celebrate = ref(0);
watch(isConnected, (connected) => {
  if (connected) celebrate.value += 1;
});
</script>

<template>
  <UDashboardPanel id="connect">
    <template #header>
      <UDashboardNavbar title="Connect">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="grid h-full grid-cols-1 gap-8 lg:grid-cols-2 lg:items-center">
        <div class="order-2 flex flex-col justify-center gap-6 lg:order-1 lg:pl-6">
          <template v-if="isConnected && info">
            <div class="space-y-1.5">
              <h1 class="text-3xl font-semibold tracking-tight text-highlighted">
                {{ info.deviceName ?? "Luna Ultra" }}
              </h1>
              <p class="font-mono text-sm text-muted">{{ info.ssid ?? info.host }}</p>
            </div>

            <div class="flex max-w-md items-center gap-3">
              <UButton size="xl" icon="i-lucide-images" label="Open gallery" to="/gallery" />
              <UButton
                class="ml-auto"
                size="xl"
                label="Disconnect"
                icon="i-lucide-unplug"
                color="neutral"
                variant="ghost"
                @click="disconnect"
              />
            </div>
          </template>

          <template v-else>
            <div class="space-y-3">
              <h1 class="text-3xl font-semibold tracking-tight text-highlighted lg:text-4xl">
                Pair your Luna Ultra
              </h1>
              <p class="max-w-md text-muted">
                Join the camera's Wi-Fi network, then connect to browse, download and manage
                everything you shot.
              </p>
            </div>

            <UAlert
              v-if="!available"
              class="max-w-md"
              icon="i-lucide-monitor-down"
              color="warning"
              variant="subtle"
              title="Desktop app required"
              description="Connecting to the camera needs the packaged Luna Ultra desktop app."
            />

            <UAlert
              v-if="error"
              class="max-w-md"
              icon="i-lucide-triangle-alert"
              color="error"
              variant="subtle"
              :title="error"
            >
              <template #actions>
                <UButton
                  label="Open settings"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  to="/settings"
                />
              </template>
            </UAlert>

            <div class="flex max-w-md items-center gap-3">
              <UButton
                size="xl"
                icon="i-lucide-cable"
                :label="isBusy ? 'Connecting' : 'Connect camera'"
                :loading="isBusy"
                :disabled="!available"
                @click="connect"
              />
              <UButton
                size="xl"
                label="View downloads"
                color="neutral"
                variant="ghost"
                to="/downloads"
              />
            </div>
          </template>
        </div>

        <div class="order-1 h-72 min-h-0 lg:order-2 lg:h-full">
          <LunaModel class="size-full" :celebrate />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
