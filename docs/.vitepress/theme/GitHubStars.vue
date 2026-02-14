<script setup>
import { ref, onMounted } from 'vue';

const stars = ref(null);

onMounted(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/KristianP26/ble-scale-sync');
    const data = await res.json();
    stars.value = data.stargazers_count;
  } catch {
    stars.value = null;
  }
});
</script>

<template>
  <a
    class="github-stars"
    href="https://github.com/KristianP26/ble-scale-sync"
    target="_blank"
    rel="noopener noreferrer"
    title="Star on GitHub"
  >
    <span v-if="stars !== null">{{ stars }}</span>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: -2px">
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>
    </svg>
  </a>
</template>

<style scoped>
.github-stars {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  transition: color 0.25s;
}
.github-stars:hover {
  color: var(--vp-c-brand-1);
}
</style>
