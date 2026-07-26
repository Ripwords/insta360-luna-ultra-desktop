import { mountSuspended } from "@nuxt/test-utils/runtime";
import { defineComponent } from "vue";

/**
 * Run a composable inside a real Nuxt app instance and hand back what it
 * returned. Composables here call `useState`, which needs a Nuxt app on the
 * call stack — hence a mounted component rather than a bare call.
 */
export async function mountComposable<T>(fn: () => T): Promise<T> {
  let result!: T;
  await mountSuspended(
    defineComponent({
      setup() {
        result = fn();
        return () => null;
      },
    }),
  );
  return result;
}
