<script setup lang="ts">
// Bumped by plugins/mock-transport.client.ts once it has registered the mock
// camera transport, post-hydration. Keying NuxtPage on it forces the active
// /demo/* page to remount as an ordinary client render against the
// now-mocked transport, rather than staying stuck with whatever DOM its
// initial hydration pass produced against the real (unregistered) transport.
// See that plugin's comment for why the registration itself is deferred.
//
// Scoped to /demo routes: the mock transport is only ever registered there
// (see that plugin), so every other route has nothing to remount for.
// Keying `NuxtPage` unconditionally forced a full remount of every docs page
// too, silently discarding any local UI state (a copy-button "copied!" flag,
// a collapsible) the page happened to be holding after its own hydration.
const demoRemountKey = useState("demo-remount-key", () => 0);
const route = useRoute();
const isDemoRoute = computed(() => route.path === "/demo" || route.path.startsWith("/demo/"));
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage :key="isDemoRoute ? demoRemountKey : undefined" />
    </NuxtLayout>
  </UApp>
</template>
