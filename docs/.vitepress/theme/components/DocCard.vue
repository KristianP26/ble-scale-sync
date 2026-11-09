<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';

// A link card in the style of the landing page's install cards: icon, title,
// one line of text, and a pill that says where the card leads.
const props = withDefaults(
  defineProps<{ title: string; link: string; icon?: string; more?: string }>(),
  { more: 'Read the guide' },
);
const href = computed(() =>
  /^(https?:)?\/\//.test(props.link) || props.link.startsWith('#')
    ? props.link
    : withBase(props.link),
);
const src = computed(() =>
  props.icon
    ? withBase(`/icons/${props.icon.includes('.') ? props.icon : `${props.icon}.svg`}`)
    : '',
);
</script>

<template>
  <div class="doc-card">
    <span v-if="icon" class="doc-card__icon" aria-hidden="true">
      <img :src="src" width="24" height="24" alt="" />
    </span>
    <div class="doc-card__body">
      <div class="doc-card__head">
        <a class="doc-card__link" :href="href">{{ title }}</a>
        <span class="doc-card__more" aria-hidden="true">
          {{ more }}
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 6h8M6.5 2.5 10 6l-3.5 3.5" />
          </svg>
        </span>
      </div>
      <div class="doc-card__text"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.doc-card {
  position: relative;
  display: flex;
  gap: 14px;
  padding: 18px 20px;
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
  transition: transform 0.2s ease;
}
.doc-card:has(.doc-card__link:hover),
.doc-card:has(.doc-card__link:focus-visible) {
  transform: translateY(-2px);
}
.doc-card__icon {
  flex: none;
  align-self: flex-start;
  display: inline-flex;
  padding: 6px;
  border-radius: 8px;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
}
.doc-card__icon img {
  display: block;
}
.doc-card__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.doc-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
}
.vp-doc .doc-card__link {
  color: var(--vp-c-text-1);
  font-size: 16px;
  font-weight: 560;
  line-height: 24px;
  text-decoration: none;
}
/* The whole card opens the link. */
.doc-card__link::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}
.doc-card__text {
  font-size: 14px;
  line-height: 22px;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}
.doc-card__text :deep(p) {
  margin: 0;
  line-height: inherit;
}
.doc-card__more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 3px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
  color: var(--vp-c-text-2);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}
.doc-card__more svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.2s ease;
}
.doc-card:has(.doc-card__link:hover) .doc-card__more,
.doc-card:has(.doc-card__link:focus-visible) .doc-card__more {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.doc-card:has(.doc-card__link:hover) .doc-card__more svg {
  transform: translateX(3px);
}
/* On a phone the pill goes under the text, so it never wraps beside a long title. */
@media (max-width: 639px) {
  .doc-card__head {
    display: contents;
  }
  .doc-card__text {
    order: 1;
  }
  .doc-card__more {
    order: 2;
    align-self: flex-start;
    margin-top: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .doc-card,
  .doc-card__more svg {
    transition: none;
  }
}
</style>
