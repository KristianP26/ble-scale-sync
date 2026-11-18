<script setup lang="ts">
// Rows by default, like the landing page's install cards; `grid` puts them in two or more columns.
defineProps<{ grid?: boolean }>();
</script>

<template>
  <div class="doc-cards" :class="{ 'doc-cards--grid': grid }"><slot /></div>
</template>

<style scoped>
.doc-cards {
  display: grid;
  gap: 12px;
  margin: 20px 0 24px;
}
.doc-cards--grid {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
</style>
