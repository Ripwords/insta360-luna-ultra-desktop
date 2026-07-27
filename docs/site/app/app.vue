<script setup lang="ts">
// Bumped by plugins/mock-transport.client.ts once it has registered the mock
// camera transport, post-hydration. Keying NuxtPage on it forces the active
// /demo/* page to remount as an ordinary client render against the
// now-mocked transport, rather than staying stuck with whatever DOM its
// initial hydration pass produced against the real (unregistered) transport.
// See that plugin's comment for why the registration itself is deferred.
const demoRemountKey = useState("demo-remount-key", () => 0);
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage :key="demoRemountKey" />
    </NuxtLayout>
  </UApp>
</template>
