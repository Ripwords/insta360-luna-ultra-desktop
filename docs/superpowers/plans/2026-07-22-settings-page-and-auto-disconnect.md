# Settings Page, Auto-Disconnect, and Layout Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move camera configuration off the home page into a dedicated `/settings` route, force-disconnect the camera after three consecutive transport failures, and fix layout and button placement across the app.

**Architecture:** A framework-free `cameraHealth` module counts consecutive transport failures and is fed from the single `cameraFetch` chokepoint in `lunaClient.ts`. `useCamera` arms it on connect and runs a hard disconnect when it fires. The UI work is additive: a new page, a component extraction, and in-place edits to existing templates. No Rust changes, no new dependencies.

**Tech Stack:** Nuxt 4 (`ssr: false`), Vue 3 script-setup, Nuxt UI v4, Tauri 2, Vitest, oxlint, Bun.

## Global Constraints

- Never use `any` to fix a type error. Use `as unknown as X` only when strictly necessary.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).
- Tests first, then implementation.
- No new runtime dependencies.
- No changes under `src-tauri/`.
- No route renames. The only new route is `/settings`.
- No font, palette, or design-token changes. Use the existing Nuxt UI semantic classes (`text-muted`, `text-highlighted`, `text-dimmed`, `bg-elevated`, `border-default`).
- Vitest runs with `environment: "node"`. There is no `localStorage`, no `window`, and no Nuxt auto-import inside tests. Only test plain modules under `app/utils/`.
- Icons come from `i-lucide-*`, matching the rest of the app.
- No em-dash characters in user-visible strings.
- Run `bun run lint` before every commit.

## File Structure

| Path                                       | Responsibility                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `app/utils/cameraHealth.ts`                | NEW. Consecutive-failure counter and armed callback. Pure module, no Vue. |
| `tests/cameraHealth.test.ts`               | NEW. Unit tests for the counter.                                          |
| `app/utils/lunaClient.ts`                  | MODIFY. `cameraFetch` reports success/failure to `cameraHealth`.          |
| `app/composables/useCamera.ts`             | MODIFY. Arm/disarm the detector, add `forceDisconnect`, persist the host. |
| `app/components/WatermarkSettingsForm.vue` | NEW. Watermark controls extracted from the download modal.                |
| `app/components/DownloadOptionsModal.vue`  | MODIFY. Consumes the extracted form.                                      |
| `app/pages/settings.vue`                   | NEW. Camera, Watermark and Appearance sections.                           |
| `app/layouts/default.vue`                  | MODIFY. Settings nav entry, `ColorwayToggle` removed from the footer.     |
| `app/components/CameraStatusChip.vue`      | MODIFY. Becomes a link to `/settings`.                                    |
| `app/pages/index.vue`                      | MODIFY. Reduced to connect/disconnect.                                    |
| `app/components/MediaPreview.vue`          | MODIFY. Header action row and arrow insets.                               |
| `app/pages/gallery.vue`                    | MODIFY. "Select day" visibility, skeleton loading state.                  |

**Not in this plan:** `app/pages/downloads.vue`. The spec asked for an empty state and an inline retry on failed rows. Both already exist (`downloads.vue:31-41` and `downloads.vue:87-95`). No work needed.

---

### Task 1: Camera health counter

**Files:**

- Create: `app/utils/cameraHealth.ts`
- Test: `tests/cameraHealth.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `FAILURE_THRESHOLD: number` (value `3`)
  - `armCameraHealth(onDead: () => void): void`
  - `disarmCameraHealth(): void`
  - `reportCameraSuccess(): void`
  - `reportCameraFailure(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/cameraHealth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_THRESHOLD,
  armCameraHealth,
  disarmCameraHealth,
  reportCameraFailure,
  reportCameraSuccess,
} from "~/utils/cameraHealth";

describe("cameraHealth", () => {
  beforeEach(() => {
    disarmCameraHealth();
  });

  it("fires once after three consecutive failures", () => {
    const onDead = vi.fn();
    armCameraHealth(onDead);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("does not fire before the threshold", () => {
    const onDead = vi.fn();
    armCameraHealth(onDead);
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) reportCameraFailure();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("resets the count on any success", () => {
    const onDead = vi.fn();
    armCameraHealth(onDead);
    reportCameraFailure();
    reportCameraSuccess();
    reportCameraFailure();
    reportCameraFailure();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("ignores failures while disarmed", () => {
    const onDead = vi.fn();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    armCameraHealth(onDead);
    reportCameraFailure();
    expect(onDead).not.toHaveBeenCalled();
  });

  it("does not fire again after it has fired", () => {
    const onDead = vi.fn();
    armCameraHealth(onDead);
    for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) reportCameraFailure();
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("replaces the callback when armed twice", () => {
    const first = vi.fn();
    const second = vi.fn();
    armCameraHealth(first);
    reportCameraFailure();
    armCameraHealth(second);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) reportCameraFailure();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run vitest run tests/cameraHealth.test.ts`
Expected: FAIL, cannot resolve `~/utils/cameraHealth`.

- [ ] **Step 3: Write the implementation**

Create `app/utils/cameraHealth.ts`:

```ts
/**
 * Watches for the camera going silent mid-session. Only transport failures
 * count: a thrown fetch (timeout, refused connection, Wi-Fi gone). Any
 * completed HTTP response, including a 404 for a missing file, proves the
 * camera is answering and resets the count, so one bad file can never end a
 * working session.
 */
export const FAILURE_THRESHOLD = 3;

let consecutiveFailures = 0;
let onDeadCallback: (() => void) | null = null;

/** Start counting. Replaces any previous callback and resets the count. */
export function armCameraHealth(onDead: () => void): void {
  consecutiveFailures = 0;
  onDeadCallback = onDead;
}

/** Stop counting. Reports become no-ops until armed again. */
export function disarmCameraHealth(): void {
  consecutiveFailures = 0;
  onDeadCallback = null;
}

export function reportCameraSuccess(): void {
  if (!onDeadCallback) return;
  consecutiveFailures = 0;
}

export function reportCameraFailure(): void {
  if (!onDeadCallback) return;
  consecutiveFailures += 1;
  if (consecutiveFailures < FAILURE_THRESHOLD) return;
  // Disarm before invoking so a burst of concurrent in-flight failures
  // cannot fire the callback more than once.
  const callback = onDeadCallback;
  disarmCameraHealth();
  callback();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run vitest run tests/cameraHealth.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add app/utils/cameraHealth.ts tests/cameraHealth.test.ts
git commit -m "feat: add camera health failure counter"
```

---

### Task 2: Feed the counter from cameraFetch and hard-disconnect

**Files:**

- Modify: `app/utils/lunaClient.ts:32-39`
- Modify: `app/composables/useCamera.ts`

**Interfaces:**

- Consumes: `armCameraHealth`, `disarmCameraHealth`, `reportCameraSuccess`, `reportCameraFailure`, `FAILURE_THRESHOLD` from Task 1.
- Produces: `useCamera()` gains no new public members. `disconnect()` keeps its existing signature `(): Promise<void>`.

- [ ] **Step 1: Report success and failure from `cameraFetch`**

In `app/utils/lunaClient.ts`, add the import beside the existing ones:

```ts
import { reportCameraFailure, reportCameraSuccess } from "~/utils/cameraHealth";
```

Replace the whole `cameraFetch` function:

```ts
/**
 * Fetch a camera URL. Uses the Tauri HTTP plugin (bypasses CORS/mixed-content)
 * when packaged. Every camera request flows through here, so this is also
 * where the health counter is fed: a completed response of any status means
 * the camera answered, a thrown request means it did not.
 */
export async function cameraFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    let response: Response;
    if (isTauri()) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      response = await tauriFetch(url, init);
    } else {
      response = await fetch(url, init);
    }
    reportCameraSuccess();
    return response;
  } catch (error) {
    reportCameraFailure();
    throw error;
  }
}
```

- [ ] **Step 2: Arm the detector and add the hard disconnect**

In `app/composables/useCamera.ts`, add the import beside the existing `lunaClient` import:

```ts
import { armCameraHealth, disarmCameraHealth, FAILURE_THRESHOLD } from "~/utils/cameraHealth";
```

Replace the existing `disconnect` function with these two functions:

```ts
/**
 * Tear down the session without touching `wantConnection`. Shared by the
 * user-initiated disconnect and the health-detector disconnect.
 */
async function teardown() {
  clearRetryTimer();
  disarmCameraHealth();
  await lunaClient.disconnect();
  status.value = "disconnected";
  info.value = null;
  library.value = [];
}

async function disconnect() {
  wantConnection.value = false;
  await teardown();
  error.value = null;
}

/**
 * The camera stopped answering. Drop the session and leave it dropped:
 * clearing `wantConnection` keeps the backoff reconnect loop dormant so it
 * cannot immediately undo this. The user reconnects deliberately.
 */
async function forceDisconnect() {
  wantConnection.value = false;
  await teardown();
  error.value = `Lost contact with the camera. Disconnected after ${FAILURE_THRESHOLD} failed requests.`;
}
```

In `connect()`, arm the detector immediately after `wantConnection.value = true;`:

```ts
wantConnection.value = true;
armCameraHealth(() => {
  void forceDisconnect();
});
```

In `tryReconnect()`, re-arm after a successful reconnect. Replace `retryAttempt.value = 0;` in the `try` block (the one directly after `error.value = null;`) with:

```ts
retryAttempt.value = 0;
armCameraHealth(() => {
  void forceDisconnect();
});
```

- [ ] **Step 3: Run the full suite**

Run: `bun run vitest run`
Expected: PASS. All existing suites stay green; `cameraFetch`'s success path is unchanged.

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/utils/lunaClient.ts app/composables/useCamera.ts
git commit -m "feat: disconnect the camera after three failed requests"
```

---

### Task 3: Persist the camera host

**Files:**

- Modify: `app/composables/useCamera.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `useCamera().host` is a `Ref<string>` restored from and written to `localStorage` under `luna-camera-host`. Later tasks bind an input straight to it.

- [ ] **Step 1: Read the stored host on first use**

In `app/composables/useCamera.ts`, add the storage key beside `DEFAULT_HOST`:

```ts
const DEFAULT_HOST = "192.168.42.1";
const HOST_STORAGE_KEY = "luna-camera-host";
```

Replace the `host` state initialiser:

```ts
const host = useState<string>("camera-host", () => {
  if (import.meta.client) {
    const stored = localStorage.getItem(HOST_STORAGE_KEY);
    if (stored) return stored;
  }
  return DEFAULT_HOST;
});
```

- [ ] **Step 2: Write it back on change**

Directly after the `const retryAttempt = ...` line, add:

```ts
// Persisted so the home page can ship a bare Connect button: a user on a
// non-default gateway should not have to retype it every launch.
if (import.meta.client) {
  watch(host, (value) => {
    localStorage.setItem(HOST_STORAGE_KEY, value.trim());
  });
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/composables/useCamera.ts
git commit -m "feat: persist the camera host across launches"
```

---

### Task 4: Extract the watermark form

**Files:**

- Create: `app/components/WatermarkSettingsForm.vue`
- Modify: `app/components/DownloadOptionsModal.vue`

**Interfaces:**

- Consumes: `useWatermarkSettings()` (existing).
- Produces: `<WatermarkSettingsForm :preview-src="string | undefined" />`. It owns the enable switch, the preview and the position picker. It renders no title, no footer and no buttons.

- [ ] **Step 1: Create the component**

Create `app/components/WatermarkSettingsForm.vue`:

```vue
<script setup lang="ts">
import { WATERMARK_POSITIONS, type WatermarkPosition } from "~/utils/watermark";

defineProps<{ previewSrc?: string }>();

const { settings } = useWatermarkSettings();

const positionLabels: Record<WatermarkPosition, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

const anchorClasses: Record<WatermarkPosition, string> = {
  "top-left": "left-2 top-2",
  "top-right": "right-2 top-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-center": "bottom-2 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-2 right-2",
};
</script>

<template>
  <div class="space-y-5">
    <USwitch
      v-model="settings.enabled"
      label="Apply Luna Ultra watermark"
      description="The official watermark is rendered into photos. Videos transfer untouched."
    />

    <div v-if="settings.enabled" class="grid grid-cols-[1fr_auto] items-start gap-4">
      <WatermarkCanvas :src="previewSrc" />
      <UFormField label="Position" :help="positionLabels[settings.position]">
        <div class="relative h-20 w-32 rounded-lg border border-default bg-muted">
          <button
            v-for="position in WATERMARK_POSITIONS"
            :key="position"
            type="button"
            class="absolute flex size-6 cursor-pointer items-center justify-center rounded-md border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :class="[
              anchorClasses[position],
              settings.position === position
                ? 'border-transparent bg-primary text-inverted'
                : 'border-default bg-elevated text-muted hover:border-accented hover:text-default',
            ]"
            :aria-label="positionLabels[position]"
            :aria-pressed="settings.position === position"
            @click="settings.position = position"
          >
            <span class="block size-1.5 rounded-[2px] bg-current" />
          </button>
        </div>
      </UFormField>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Consume it from the modal**

Replace the entire contents of `app/components/DownloadOptionsModal.vue`:

```vue
<script setup lang="ts">
import type { MediaItem } from "~/types/media";

const props = defineProps<{ items: MediaItem[] }>();

const emit = defineEmits<{ close: [confirmed: boolean] }>();

const photos = computed(() => props.items.filter((item) => item.type === "photo"));
const videos = computed(() => props.items.filter((item) => item.type === "video"));
const previewSrc = computed(() => photos.value[0]?.srcUrl);

const summary = computed(() => {
  const parts: string[] = [];
  if (photos.value.length > 0)
    parts.push(`${photos.value.length} ${photos.value.length === 1 ? "photo" : "photos"}`);
  if (videos.value.length > 0)
    parts.push(`${videos.value.length} ${videos.value.length === 1 ? "video" : "videos"}`);
  return parts.join(" and ");
});
</script>

<template>
  <UModal
    :close="{ onClick: () => emit('close', false) }"
    :title="`Download ${summary}`"
    description="Files save to the Luna Ultra folder in Downloads."
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <WatermarkSettingsForm v-if="photos.length > 0" :preview-src="previewSrc" />
      <p v-else class="text-sm text-muted">
        Videos transfer untouched. Watermarking currently applies to photos only.
      </p>
    </template>

    <template #footer>
      <UButton label="Cancel" color="neutral" variant="outline" @click="emit('close', false)" />
      <UButton
        :label="items.length === 1 ? 'Download' : `Download ${items.length} files`"
        icon="i-lucide-arrow-down-to-line"
        @click="emit('close', true)"
      />
    </template>
  </UModal>
</template>
```

- [ ] **Step 3: Verify the modal in the app**

Run: `bun run ui:dev`, open the gallery against the mock server (`luna_mock_server`), select a photo and press Download.
Expected: the modal looks and behaves exactly as before. The position picker now shows a focus ring when tabbed to.

- [ ] **Step 4: Typecheck, lint and commit**

```bash
bun run typecheck && bun run lint
git add app/components/WatermarkSettingsForm.vue app/components/DownloadOptionsModal.vue
git commit -m "refactor: extract WatermarkSettingsForm from the download modal"
```

---

### Task 5: Settings page and navigation

**Files:**

- Create: `app/pages/settings.vue`
- Modify: `app/layouts/default.vue`
- Modify: `app/components/CameraStatusChip.vue`

**Interfaces:**

- Consumes: `useCamera()` (`info`, `library`, `host`, `error`, `isConnected`, `isBusy`, `available`, `connect`, `disconnect`), `useWatermarkSettings()` (`reset`), `WatermarkSettingsForm` from Task 4, `ColorwayToggle` (existing).
- Produces: the `/settings` route.

- [ ] **Step 1: Create the page**

Create `app/pages/settings.vue`:

```vue
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
              :disabled="isBusy || !available"
              autocomplete="off"
              spellcheck="false"
              class="w-full font-mono"
            />
            <template #help>
              Default Luna Ultra Wi-Fi gateway. Include a port for the dev mock (127.0.0.1:18080).
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

          <ColorwayToggle />
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 2: Add the nav entry and drop the footer toggle**

In `app/layouts/default.vue`, split the nav into two groups. Replace the `items` computed:

```ts
const items = computed<NavigationMenuItem[][]>(() => [
  [
    {
      label: "Connect",
      icon: "i-lucide-cable",
      to: "/",
      active: route.path === "/",
    },
    {
      label: "Gallery",
      icon: "i-lucide-images",
      to: "/gallery",
    },
    {
      label: "Downloads",
      icon: "i-lucide-arrow-down-to-line",
      to: "/downloads",
      badge: active.value.length > 0 ? String(active.value.length) : undefined,
    },
  ],
  [
    {
      label: "Settings",
      icon: "i-lucide-settings",
      to: "/settings",
    },
  ],
]);
```

`UNavigationMenu` renders a nested array as separated groups, which is what puts Settings below a divider.

Then remove `ColorwayToggle` from the sidebar footer. Replace the `#footer` template:

```vue
<template #footer="{ collapsed }">
  <div class="flex w-full flex-col gap-3" :class="collapsed ? 'items-center' : ''">
    <UpdateBanner :collapsed="collapsed" />
    <CameraStatusChip :collapsed="collapsed" />
  </div>
</template>
```

- [ ] **Step 3: Make the status chip a link**

In `app/components/CameraStatusChip.vue`, wrap the badge in a `NuxtLink`. Replace the template:

```vue
<template>
  <UTooltip :text="tooltip">
    <NuxtLink
      to="/settings"
      class="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      :class="collapsed ? '' : 'w-full'"
      aria-label="Camera settings"
    >
      <UBadge
        :color="meta.color"
        variant="subtle"
        size="md"
        :class="collapsed ? 'px-1.5' : 'w-full justify-start'"
      >
        <UIcon
          :name="meta.icon"
          class="size-3.5 shrink-0"
          :class="meta.spin ? 'animate-spin' : ''"
        />
        <span v-if="!collapsed">{{ meta.label }}</span>
      </UBadge>
    </NuxtLink>
  </UTooltip>
</template>
```

- [ ] **Step 4: Verify in the app**

Run: `bun run ui:dev`. Click Settings in the sidebar.
Expected: three sections in one narrow column, Settings sits below a divider under Downloads, the sidebar footer no longer shows the colourway buttons, and the status chip navigates to `/settings`. Check the page in both light and dark.

- [ ] **Step 5: Typecheck, lint and commit**

```bash
bun run typecheck && bun run lint
git add app/pages/settings.vue app/layouts/default.vue app/components/CameraStatusChip.vue
git commit -m "feat: add a dedicated settings page"
```

---

### Task 6: Reduce the home page to connect and disconnect

**Files:**

- Modify: `app/pages/index.vue`

**Interfaces:**

- Consumes: `useCamera()`, `LunaModel` (existing), the `/settings` route from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the page**

Replace the entire contents of `app/pages/index.vue`:

```vue
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
          <LunaModel class="size-full" :celebrate="celebrate" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 2: Verify in the app**

Run: `bun run ui:dev`.
Expected: no address field on the home page, no device table, one primary button per state, no Disconnect in the navbar. Connecting against the mock server still works using the persisted host from Task 3, and a failed connect shows the alert with an "Open settings" action.

- [ ] **Step 3: Typecheck, lint and commit**

```bash
bun run typecheck && bun run lint
git add app/pages/index.vue
git commit -m "feat: reduce the home page to connect and disconnect"
```

---

### Task 7: Media preview action row and arrow insets

**Files:**

- Modify: `app/components/MediaPreview.vue:84-88` (header actions)
- Modify: `app/components/MediaPreview.vue:143-166` (prev/next arrows)

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing consumed by later tasks. The `download`, `delete` and `open` emits are unchanged.

- [ ] **Step 1: Rebuild the header action row**

In `app/components/MediaPreview.vue`, add a dropdown items computed to the `<script setup>` block, after the existing `takenLabel` definition:

```ts
const moreItems = computed(() => [
  [
    {
      label: "Delete from camera",
      icon: "i-lucide-trash-2",
      color: "error" as const,
      onSelect: () => emit("delete"),
    },
  ],
]);
```

Replace the header action row (the `<div class="flex items-center gap-1.5">` holding the three buttons):

```vue
<div class="flex items-center gap-1.5">
            <UButton icon="i-lucide-arrow-down-to-line" label="Download" size="sm" color="neutral" variant="outline" @click="emit('download')" />
            <UDropdownMenu :items="moreItems">
              <UButton icon="i-lucide-ellipsis" size="sm" color="neutral" variant="ghost" aria-label="More actions" />
            </UDropdownMenu>
            <span class="mx-1 h-5 w-px bg-default" aria-hidden="true" />
            <UButton icon="i-lucide-x" size="sm" color="neutral" variant="ghost" aria-label="Close preview" @click="open = false" />
          </div>
```

Delete is no longer a single click sitting next to Download. It takes opening the menu first, which is the point: it erases from the camera and cannot be undone.

- [ ] **Step 2: Inset the prev/next arrows**

The image area is the `<div class="relative flex min-h-0 flex-1 items-center justify-center bg-black/95 dark:bg-black">`. Give it horizontal padding so a wide image cannot run under the arrows, and pull the arrows into that padding.

Change that div's class to:

```
relative flex min-h-0 flex-1 items-center justify-center bg-black/95 px-16 dark:bg-black
```

Then change the two arrow buttons' positioning classes from `left-4` and `right-4` to `left-3` and `right-3`:

```vue
<UButton
  v-if="hasPrev"
  icon="i-lucide-chevron-left"
  size="lg"
  color="neutral"
  variant="solid"
  class="absolute left-3 top-1/2 -translate-y-1/2"
  aria-label="Previous file"
  @click="emit('prev')"
/>
<UButton
  v-if="hasNext"
  icon="i-lucide-chevron-right"
  size="lg"
  color="neutral"
  variant="solid"
  class="absolute right-3 top-1/2 -translate-y-1/2"
  aria-label="Next file"
  @click="emit('next')"
/>
```

`PanoViewer` and the loading overlay use `absolute inset-0`, so they still fill the area edge to edge; only the `object-contain` image is inset, which is what we want.

- [ ] **Step 3: Verify in the app**

Run: `bun run ui:dev`, open a photo in the gallery preview.
Expected: Download is a labelled outline button, Delete lives behind the ellipsis menu, Close sits after a hairline separator. A wide photo no longer runs underneath the arrows. The image stays centred (the fix from the earlier commit still holds).

- [ ] **Step 4: Typecheck, lint and commit**

```bash
bun run typecheck && bun run lint
git add app/components/MediaPreview.vue
git commit -m "fix: separate delete from download in the media preview"
```

---

### Task 8: Gallery day selection and skeleton loading

**Files:**

- Modify: `app/pages/gallery.vue:216-226` (the day heading row)
- Modify: `app/pages/gallery.vue:215-219` (the loading state block)

**Interfaces:**

- Consumes: `tileMin` (existing computed), `loadingLibrary` (existing).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Stop hiding "Select day" behind hover**

In `app/pages/gallery.vue`, replace the day heading row:

```vue
<div class="mb-2.5 flex items-baseline gap-3">
            <h2 class="text-sm font-semibold text-highlighted">{{ group.label }}</h2>
            <span class="font-mono text-xs text-muted tabular-nums">{{ group.items.length }}</span>
            <UButton
              :label="group.items.every((i) => selected.has(i.id)) ? 'Deselect day' : 'Select day'"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="selectGroup(group.items.map((i) => i.id))"
            />
          </div>
```

The `group/day` class and the `opacity-0` / `group-hover/day:opacity-100` pair are gone. A control that performs a real action should not be invisible until the pointer happens to land on it, and it was unreachable by pointerless navigation.

- [ ] **Step 2: Replace the loading spinner with grid skeletons**

Replace the loading branch (the `v-else-if="loadingLibrary && groups.length === 0"` block):

```vue
      <div v-else-if="loadingLibrary && groups.length === 0" class="space-y-8" aria-busy="true">
        <section v-for="section in 2" :key="section">
          <div class="mb-2.5 h-5 w-32 animate-pulse rounded bg-elevated" />
          <div
            class="grid gap-2"
            :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileMin}px, 1fr))` }"
          >
            <div v-for="tile in 12" :key="tile" class="aspect-square animate-pulse rounded-lg bg-elevated" />
          </div>
        </section>
      </div>
```

Same grid template as the real content, so nothing shifts when the library lands.

- [ ] **Step 3: Verify in the app**

Run: `bun run ui:dev`, connect against the mock server and watch the gallery load.
Expected: skeleton tiles in the real grid shape rather than a centred spinner, no layout jump when the library arrives, and "Select day" visible on every day heading without hovering.

- [ ] **Step 4: Typecheck, lint and commit**

```bash
bun run typecheck && bun run lint
git add app/pages/gallery.vue
git commit -m "fix: reveal day selection and use grid skeletons while loading"
```

---

### Task 9: Full verification

**Files:** none.

- [ ] **Step 1: Run everything**

```bash
bun run vitest run && bun run typecheck && bun run lint
```

Expected: all suites pass, no type errors, no lint errors.

- [ ] **Step 2: Manual pass against the mock server**

Start `luna_mock_server`, run `bun run ui:dev`, then walk through:

1. Connect from the home page with no prior configuration. It uses the default host.
2. Change the host in Settings to the mock address, reload the app, confirm the value survived.
3. Browse the gallery, open a preview, confirm centring, the action row and the arrow insets.
4. Kill the mock server, keep scrolling the gallery so thumbnails fail. After three failed requests the session drops with "Lost contact with the camera. Disconnected after 3 failed requests." and does not silently reconnect.
5. Restart the mock server, reconnect from the home page, confirm the session recovers.
6. Repeat steps 3 and 4 in the other colour mode.

- [ ] **Step 3: Report honestly**

Any step that could not be verified is stated as unverified in the summary, not implied to have passed.
