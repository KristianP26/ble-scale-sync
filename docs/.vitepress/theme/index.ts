import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import GitHubStars from './GitHubStars.vue';
import HomeLanding from './HomeLanding.vue';
import { h } from 'vue';
import '@fontsource-variable/instrument-sans/wdth.css';
import '@fontsource/dm-mono/400.css';
import './styles/custom.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(GitHubStars),
    });
  },
  enhanceApp({ app }) {
    app.component('HomeLanding', HomeLanding);
  },
} satisfies Theme;
