# Workflow

## Before every commit

Formatting and auto-fixable lint are handled automatically: the `pre-commit` hook
runs `lint-staged`, which applies `oxfmt` and `oxlint --fix` to the staged files
and re-stages the results. Anything left unfixed aborts the commit.

To run the same checks manually across the whole repo:

```sh
bun run fmt       # oxfmt, writes in place
bun run lint:fix  # oxlint --fix --deny-warnings
```

Warnings are treated as failures, so never commit with lint output outstanding.
`git commit --no-verify` skips the hook — don't, unless the hook itself is broken.

# Vue Conventions

**Not lint-enforced — apply these by hand.** oxlint strips `<template>` before any
rule runs, so the first two can't be checked automatically. Check them whenever you
write or edit a `.vue` file.

## Prop shorthand

When a prop name matches the name of the value being passed, use the shorthand.

```vue
<script setup lang="ts">
const test = "hello";
</script>

<template>
  <!-- Bad -->
  <Test :test="test" />

  <!-- Good -->
  <Test :test />
</template>
```

Two things that look like violations but are not — leave them alone:

```vue
<!-- kebab-case can't shorthand: `:some-prop` isn't a valid identifier -->
<Test :some-prop="someProp" />

<!-- v-model is a two-way binding, not a v-bind; shorthand would break it -->
<Test v-model:open="open" />
```

## Template refs

Use `useTemplateRef()` instead of a manually typed `ref`.

```ts
// Bad
const el = ref<HTMLElement | null>(null);

// Good
const el = useTemplateRef("example");
```

Applies only to refs actually bound to a `ref="..."` in the template — a plain
`ref<HTMLElement>()` that just holds an element is fine as-is. Note
`useTemplateRef` returns a **readonly** ref, so it can't be used where the code
assigns to `.value`.

## Default props

Use destructuring defaults on `defineProps`, not `withDefaults()`.

```ts
// Bad
const props = withDefaults(defineProps<{ foo?: string }>(), { foo: "hello" });

// Good
const { foo = "hello" } = defineProps<{ foo?: string }>();
```
