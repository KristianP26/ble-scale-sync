<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';

// A real product icon from /icons on a white tile, sized for a table cell or a list line.
const props = withDefaults(defineProps<{ id: string; size?: number }>(), { size: 18 });
const src = computed(() =>
  withBase(`/icons/${props.id.includes('.') ? props.id : `${props.id}.svg`}`),
);
</script>

<template>
  <span class="doc-icon" aria-hidden="true">
    <img :src="src" :width="size" :height="size" alt="" loading="lazy" />
  </span>
</template>

<style scoped>
.doc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  margin-right: 8px;
  border-radius: 7px;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
  vertical-align: -8px;
}
.doc-icon img {
  display: block;
}
</style>
