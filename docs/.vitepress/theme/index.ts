import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import GitHubStars from './GitHubStars.vue';
import { h } from 'vue';
import './styles/custom.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(GitHubStars),
    });
  },
} satisfies Theme;
