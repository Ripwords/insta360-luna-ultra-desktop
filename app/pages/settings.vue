<script setup lang="ts">
const { info, library, host, error, isConnected, isBusy, available, connect, disconnect } =
  useCamera();
const { reset: resetWatermark } = useWatermarkSettings();

useHead({ title: "Settings" });
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-2xl space-y-10 pb-12">
        <section class="space-y-4">
          <div class="space-y-1">
            <h2 class="text-sm font-semibold text-highlighted">Camera</h2>
            <p class="text-sm text-muted">Where the app looks for your Luna Ultra.</p>
          </div>

          <UAlert
            v-if="!available"
            icon="i-lucide-monitor-down"
            color="warning"
            variant="subtle"
            title="Desktop app required"
            description="Connecting to the camera needs the packaged Luna Ultra desktop app."
          />

          <UFormField label="Camera address" name="host">
            <UInput
              v-model="host"
              placeholder="192.168.42.1"
              icon="i-lucide-router"
              :disabled="isBusy || isConnected || !available"
              autocomplete="off"
              spellcheck="false"
              class="w-full font-mono"
            />
            <template #help>
              Default Luna Ultra Wi-Fi gateway. Include a port for the dev mock (127.0.0.1:18080).
              <template v-if="isConnected"> Disconnect first to change the address.</template>
            </template>
          </UFormField>

          <UAlert
            v-if="error"
            icon="i-lucide-triangle-alert"
            color="error"
            variant="subtle"
            :title="error"
          >
            <template #description>
              <ul class="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                <li>Make sure your computer is joined to the camera's Wi-Fi network.</li>
                <li>
                  Confirm the address matches the camera's gateway (default
                  <span class="font-mono">192.168.42.1</span>).
                </li>
                <li>
                  On macOS, allow <span class="font-medium">Luna Ultra Desktop</span> under System
                  Settings &rsaquo; Privacy &amp; Security &rsaquo; Local Network.
                </li>
              </ul>
            </template>
          </UAlert>

          <dl
            v-if="isConnected && info"
            class="grid grid-cols-2 gap-x-8 gap-y-4 border-t border-default pt-4 text-sm"
          >
            <div>
              <dt class="text-muted">Device</dt>
              <dd class="mt-0.5 text-default">{{ info.deviceName ?? "Luna Ultra" }}</dd>
            </div>
            <div>
              <dt class="text-muted">Address</dt>
              <dd class="mt-0.5 font-mono tabular-nums text-default">{{ info.host }}</dd>
            </div>
            <div v-if="info.serial">
              <dt class="text-muted">Serial</dt>
              <dd class="mt-0.5 font-mono text-default">{{ info.serial }}</dd>
            </div>
            <div v-if="info.firmware">
              <dt class="text-muted">Firmware</dt>
              <dd class="mt-0.5 font-mono text-default">{{ info.firmware }}</dd>
            </div>
            <div>
              <dt class="text-muted">Media</dt>
              <dd class="mt-0.5 font-mono tabular-nums text-default">{{ library.length }} files</dd>
            </div>
          </dl>

          <div class="flex justify-end border-t border-default pt-4">
            <UButton
              v-if="isConnected"
              label="Disconnect"
              icon="i-lucide-unplug"
              color="neutral"
              variant="outline"
              @click="disconnect"
            />
            <UButton
              v-else
              label="Connect camera"
              icon="i-lucide-cable"
              :loading="isBusy"
              :disabled="!available"
              @click="connect"
            />
          </div>
        </section>

        <section class="space-y-4">
          <div class="space-y-1">
            <h2 class="text-sm font-semibold text-highlighted">Watermark</h2>
            <p class="text-sm text-muted">
              Applied to photos as they download. Videos transfer untouched.
            </p>
          </div>

          <WatermarkSettingsForm />

          <div class="flex justify-end border-t border-default pt-4">
            <UButton
              label="Reset to default"
              icon="i-lucide-rotate-ccw"
              color="neutral"
              variant="ghost"
              @click="resetWatermark"
            />
          </div>
        </section>

        <section class="space-y-4">
          <div class="space-y-1">
            <h2 class="text-sm font-semibold text-highlighted">Appearance</h2>
            <p class="text-sm text-muted">Colourway for the app window.</p>
          </div>

          <!-- Constrained here only: the sidebar still wants the full-width toggle. -->
          <div class="max-w-xs">
            <ColorwayToggle />
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
