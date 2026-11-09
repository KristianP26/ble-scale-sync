<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

type Card = 'garmin' | 'ha' | 'strava';

// Lines from a real run: every message below is printed by src/ as written
// (run.ts, ble/shared.ts, runtime/processor.ts, orchestrator.ts, exporters/).
// Only the timestamp is shortened to the time of day.
const log: { t: string; scope: string; msg: string; ok?: boolean; card?: Card }[] = [
  { t: '07:12:01', scope: 'Sync', msg: 'Scanning for any recognized scale...' },
  { t: '07:12:09', scope: 'BLE', msg: 'Subscribed to notifications. Step on the scale.' },
  { t: '07:12:16', scope: 'BLE', msg: 'Reading complete: 78.42 kg / 512 Ohm' },
  { t: '07:12:16', scope: 'Sync', msg: 'Measurement: 78.42 kg / 512 Ohm' },
  { t: '07:12:16', scope: 'Sync', msg: 'Body composition:' },
  { t: '07:12:16', scope: 'Sync', msg: '  bmi: 24.2' },
  { t: '07:12:16', scope: 'Sync', msg: '  bodyFatPercent: 18.6' },
  { t: '07:12:16', scope: 'Sync', msg: '  waterPercent: 56.9' },
  { t: '07:12:16', scope: 'Sync', msg: '  muscleMass: 60.71 kg' },
  { t: '07:12:16', scope: 'Sync', msg: '  visceralFat: 7' },
  { t: '07:12:16', scope: 'Sync', msg: 'Exporting to: garmin, mqtt, strava...' },
  { t: '07:12:18', scope: 'Garmin', msg: 'Garmin upload succeeded.', ok: true, card: 'garmin' },
  {
    t: '07:12:18',
    scope: 'MQTT',
    msg: 'Published to scale/body-composition (qos=1, retain=true).',
    ok: true,
    card: 'ha',
  },
  {
    t: '07:12:19',
    scope: 'Strava',
    msg: 'Strava weight updated to 78.42 kg.',
    ok: true,
    card: 'strava',
  },
  { t: '07:12:19', scope: 'Sync', msg: 'Waiting 30s before next scan...' },
];

const cards: { id: Card; name: string; icon: string; detail: string; status: string }[] = [
  {
    id: 'garmin',
    name: 'Garmin Connect',
    icon: 'garmin.png',
    detail: '78.42 kg, body fat 18.6 %',
    status: 'Uploaded',
  },
  {
    id: 'ha',
    name: 'Home Assistant',
    icon: 'homeassistant',
    detail: 'Weight and composition over MQTT',
    status: 'Published',
  },
  {
    id: 'strava',
    name: 'Strava',
    icon: 'strava',
    detail: 'Profile weight 78.42 kg',
    status: 'Updated',
  },
];

// Hero stats. check:counts guards the two derived numbers by these exact lines.
const stats = [
  { n: 42, label: 'scale protocols' },
  { n: 13, label: 'export targets' },
  { n: 4, label: 'ways to reach the scale' },
];

const transports = [
  { name: "This host's Bluetooth", icon: 'bluetooth', link: '/guide/transports' },
  { name: 'ESP32 proxy', icon: 'espressif', link: '/guide/esp32-proxy' },
  { name: 'ESPHome proxy', icon: 'esphome', link: '/guide/esphome-proxy' },
  { name: 'Home Assistant Bluetooth', icon: 'homeassistant', link: '/guide/ha-bluetooth' },
];

// Every exporter in src/exporters/registry.ts, in four groups so the right side
// mirrors the four transports on the left. Thirteen in all, the count in the hero.
const groups = [
  {
    name: 'Fitness apps',
    items: [
      { name: 'Garmin Connect', icon: 'garmin.png', link: '/exporters#garmin' },
      { name: 'Strava', icon: 'strava', link: '/exporters#strava' },
      { name: 'Intervals.icu', icon: 'intervals.png', link: '/exporters#intervals' },
      { name: 'Runalyze', icon: 'runalyze.png', link: '/exporters#runalyze' },
    ],
  },
  {
    name: 'Smart home and data',
    items: [
      { name: 'Home Assistant', icon: 'homeassistant', link: '/exporters#mqtt' },
      { name: 'InfluxDB', icon: 'influxdb', link: '/exporters#influxdb' },
      { name: 'Webhook', icon: 'webhook', link: '/exporters#webhook' },
      { name: 'CSV or JSONL', icon: 'file', link: '/exporters#file' },
    ],
  },
  {
    name: 'Self-hosted trackers',
    items: [
      { name: 'Wger', icon: 'wger', link: '/exporters#wger' },
      { name: 'HealthLog', icon: 'healthlog', link: '/exporters#healthlog' },
      { name: 'Dreeve', icon: 'dreeve', link: '/exporters#dreeve' },
    ],
  },
  {
    name: 'Notifications',
    items: [
      { name: 'Telegram', icon: 'telegram', link: '/exporters#telegram' },
      { name: 'Ntfy', icon: 'ntfy', link: '/exporters#ntfy' },
    ],
  },
];

const runsOn = [
  { name: 'Home Assistant add-on', icon: 'homeassistant' },
  { name: 'Docker', icon: 'docker' },
  { name: 'Node.js', icon: 'nodedotjs' },
];

// `cmd` is what Copy puts on the clipboard, `show` the short form on the card.
// The Docker one is the setup wizard from docs/guide/getting-started.md (step 1),
// the one-shot container that finds the scale and writes config.yaml.
const dockerSetup = [
  'docker run --rm -it \\',
  '  --network host \\',
  '  --cap-add NET_ADMIN --cap-add NET_RAW \\',
  '  --group-add "$(getent group bluetooth | cut -d: -f3)" \\',
  '  -v /var/run/dbus:/var/run/dbus:ro \\',
  '  -v ./config.yaml:/app/config.yaml \\',
  '  -v ./garmin-tokens:/app/garmin-tokens \\',
  '  -v ./strava-tokens:/app/strava-tokens \\',
  '  ghcr.io/kristianp26/ble-scale-sync:latest setup',
].join('\n');

const installs: {
  name: string;
  icon: string;
  where: string;
  cmd: string;
  show?: string;
  link: string;
  badge?: boolean;
}[] = [
  {
    name: 'Docker container',
    icon: 'docker',
    where: 'Linux, including Raspberry Pi and NAS.',
    cmd: dockerSetup,
    show: 'docker run --rm -it ... setup',
    link: '/guide/getting-started#docker',
  },
  {
    name: 'Home Assistant add-on',
    icon: 'homeassistant',
    where: 'Home Assistant OS or Supervised, set up in the add-on UI.',
    cmd: '',
    badge: true,
    link: '/guide/home-assistant-addon',
  },
  {
    name: 'Node.js package',
    icon: 'nodedotjs',
    where: "Linux, macOS and Windows, on the host's own Bluetooth.",
    cmd: 'npm install -g ble-scale-sync',
    link: '/guide/getting-started#standalone',
  },
];

// The setup wizard as it prints, prompts and messages copied from
// src/wizard/steps/ble.ts and exporters.ts, the theme from @inquirer/prompts.
// The scale and its address are an example.
const wizard: { k: 'q' | 'a' | 'ok' | 'dim' | 'sel' | 'off' | ''; text: string }[] = [
  {
    k: 'a',
    text: '\u2714 How do you want to identify your scale? Scan for nearby scales (Recommended)',
  },
  { k: '', text: '' },
  { k: '', text: 'Scanning for BLE devices... (15 seconds)' },
  { k: 'dim', text: 'Make sure your scale is powered on (step on it to wake it up).' },
  { k: '', text: '' },
  { k: 'ok', text: '\u2714  Found 1 recognized scale(s):' },
  { k: '', text: '' },
  { k: '', text: '  5C:E5:0C:4A:7B:21  MIBFS  [Xiaomi Mi Scale 2]' },
  { k: '', text: '' },
  { k: 'a', text: '\u2714 Use MIBFS (5C:E5:0C:4A:7B:21)? Yes' },
  { k: 'ok', text: '  \u2714  Scale MAC set to: 5C:E5:0C:4A:7B:21' },
  { k: '', text: '' },
  { k: '', text: 'Select export targets:' },
  { k: '', text: '' },
  { k: 'q', text: '? Exporters:' },
  {
    k: 'sel',
    text: '\u276f\u25c9 Garmin Connect (per-user) \u2014 Upload body composition data to Garmin Connect',
  },
  {
    k: 'sel',
    text: ' \u25c9 MQTT (shared) \u2014 Publish body composition data to an MQTT broker (supports Home Assistant auto-discovery)',
  },
  {
    k: 'off',
    text: ' \u25ef InfluxDB (shared) \u2014 Write body composition data to InfluxDB (v2, and v3 via its v2-compatible write API)',
  },
  {
    k: 'sel',
    text: ' \u25c9 Strava (per-user) \u2014 Update weight in your Strava athlete profile',
  },
  {
    k: 'off',
    text: ' \u25ef Telegram (shared) \u2014 Send measurement notifications to a Telegram chat via a bot',
  },
];

// The target groups stack as tight as their content, so the lines to them are
// measured: the right art is as tall as the flow and each line ends at the centre
// of its group. The server render starts from an even guess.
const flow = ref<HTMLElement | null>(null);
const outH = ref(400);
const outY = ref([50, 150, 250, 350]);
let ro: ResizeObserver | undefined;
function measure() {
  const f = flow.value;
  if (!f) return;
  // offsetTop, not the bounding box, so the draw-in's 8px rise does not count.
  const ys = [...f.querySelectorAll<HTMLElement>('.bss-group')].map((g) => {
    const col = g.offsetParent as HTMLElement;
    return Math.round(col.offsetTop + g.offsetTop + g.offsetHeight / 2);
  });
  if (ys.length === 4 && f.offsetHeight > 0) {
    outH.value = f.offsetHeight;
    outY.value = ys;
  }
}
// The transports sit in one tight stack, 200px tall (four 44px nodes, 8px apart),
// so their lines are drawn 1:1 in a 200-unit art centred on the hub.
const leftY = [22, 74, 126, 178];
const leftMid = 100;
const curve = (a: number, b: number) => `M0 ${a} C 50 ${a}, 50 ${b}, 100 ${b}`;

const haRepo =
  'https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync';

const icon = (id: string) => withBase(`/icons/${id.includes('.') ? id : `${id}.svg`}`);

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// The log streams in line by line on load and when the pointer enters; a result
// card arrives with the exporter line that names it. Server render shows it all.
const shown = ref(log.length);
const arrived = computed(
  () => new Set(log.slice(0, shown.value).flatMap((l) => (l.card ? [l.card] : []))),
);
let streamTimer: ReturnType<typeof setInterval> | undefined;
function stream() {
  if (reduced()) return;
  clearInterval(streamTimer);
  shown.value = 1;
  streamTimer = setInterval(() => {
    shown.value += 1;
    if (shown.value >= log.length) clearInterval(streamTimer);
  }, 260);
}

// The flow draws in once when the band comes into view.
const band = ref<HTMLElement | null>(null);
const armed = ref(false);
const inView = ref(false);
let io: IntersectionObserver | undefined;

const copied = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(cmd: string) {
  try {
    await navigator.clipboard.writeText(cmd);
    copied.value = cmd;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = ''), 1600);
  } catch {
    // No clipboard access: the command stays selectable.
  }
}

onMounted(() => {
  stream();
  measure();
  if (typeof ResizeObserver === 'function' && flow.value) {
    ro = new ResizeObserver(measure);
    ro.observe(flow.value);
  }
  if (reduced() || typeof IntersectionObserver !== 'function' || !band.value) return;
  armed.value = true;
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        inView.value = true;
        io?.disconnect();
      }
    },
    { threshold: 0.25 },
  );
  io.observe(band.value);
});

onBeforeUnmount(() => {
  clearInterval(streamTimer);
  clearTimeout(copiedTimer);
  io?.disconnect();
  ro?.disconnect();
});
</script>

<template>
  <div class="bss">
    <section class="bss-sec bss-hero" aria-labelledby="bss-h1" data-enter>
      <div class="bss-wrap bss-grid">
        <div class="bss-hero__text">
          <h1 id="bss-h1">Smart scale sync, anywhere</h1>
          <p class="bss-lead">
            BLE Scale Sync reads your Bluetooth scale from a Raspberry Pi, a NAS, Home Assistant or
            a desktop, and sends each weigh-in to 13 export targets, Garmin Connect and Strava among
            them.
          </p>
          <div class="bss-btns">
            <a class="bss-btn bss-btn--primary" :href="withBase('/guide/getting-started')"
              >Install BLE Scale Sync</a
            >
            <a class="bss-btn bss-btn--secondary" :href="withBase('/guide/supported-scales')"
              >Find your scale</a
            >
          </div>
          <p class="bss-proof">
            Linux, macOS or Windows. Local Bluetooth, an ESP32 or an ESPHome proxy.
          </p>
          <dl class="bss-stats">
            <div v-for="s in stats" :key="s.label">
              <dt>{{ s.label }}</dt>
              <dd>{{ s.n }}</dd>
            </div>
          </dl>
        </div>

        <div
          class="bss-hero__art"
          role="img"
          aria-label="BLE Scale Sync log: a weigh-in of 78.42 kg read over Bluetooth, its body composition, and the upload to Garmin Connect, Home Assistant and Strava"
          @mouseenter="stream"
        >
          <div class="bss-term" aria-hidden="true">
            <div class="bss-term__bar">
              <span class="bss-dots"><i></i><i></i><i></i></span>
              <span>docker logs -f ble-scale-sync</span>
            </div>
            <div class="bss-term__body">
              <div
                v-for="(l, i) in log"
                v-show="i < shown"
                :key="i"
                class="bss-term__ln"
                :class="{ 'is-ok': l.ok, 'is-detail': l.msg.startsWith('  ') }"
              >
                <span class="bss-term__t">{{ l.t }}</span
                ><span class="bss-term__s">[{{ l.scope }}]</span
                ><span class="bss-term__m">{{ l.msg }}</span>
              </div>
            </div>
          </div>
          <div class="bss-results" aria-hidden="true">
            <div
              v-for="c in cards"
              :key="c.id"
              class="bss-result"
              :class="{ 'is-on': arrived.has(c.id) }"
            >
              <img :src="icon(c.icon)" alt="" width="20" height="20" />
              <b>{{ c.name }}</b>
              <span class="bss-result__d">{{ c.detail }}</span>
              <span class="bss-chip is-on">{{ c.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section
      ref="band"
      class="bss-sec bss-band"
      :class="{ 'is-armed': armed, 'is-in': inView }"
      aria-labelledby="bss-flow"
    >
      <div class="bss-wrap">
        <h2 id="bss-flow">
          From the scale to your apps.
          <span class="bss-muted bss-h2-line">No phone in between.</span>
        </h2>
        <p class="bss-intro">
          The scale is recognised from its Bluetooth advertisement.
          <a class="bss-link" :href="withBase('/guide/supported-scales')">See the scale list</a>
        </p>

        <div
          ref="flow"
          class="bss-flow"
          role="group"
          aria-label="How a weigh-in travels from the scale to your apps"
        >
          <div class="bss-scale">
            <img :src="withBase('/img/scale.webp')" alt="" width="480" height="480" />
          </div>
          <svg
            class="bss-flow__lines bss-flow__lines--left bss-flow__lines--scale"
            viewBox="0 0 100 200"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              v-for="y in leftY"
              :key="y"
              :d="curve(leftMid, y)"
              pathLength="1"
              style="--ld: 0s"
            />
            <circle
              v-for="(y, i) in leftY"
              :key="'s' + y"
              r="2.2"
              class="bss-pulse"
              :style="{ '--pd': `${i * 1.4}s`, offsetPath: `path('${curve(leftMid, y)}')` }"
            />
          </svg>
          <div class="bss-flow__col bss-flow__col--in">
            <span class="bss-flow__head">Read by</span>
            <a v-for="t in transports" :key="t.name" class="bss-node" :href="withBase(t.link)">
              <img :src="icon(t.icon)" alt="" width="20" height="20" />{{ t.name }}
            </a>
          </div>
          <svg
            class="bss-flow__lines bss-flow__lines--left"
            viewBox="0 0 100 200"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              v-for="y in leftY"
              :key="y"
              :d="curve(y, leftMid)"
              pathLength="1"
              style="--ld: 0.45s"
            />
            <circle
              v-for="(y, i) in leftY"
              :key="'p' + y"
              r="2.2"
              class="bss-pulse"
              :style="{
                '--pd': `${0.7 + i * 1.4}s`,
                offsetPath: `path('${curve(y, leftMid)}')`,
              }"
            />
          </svg>
          <div class="bss-hub">
            <div class="bss-hub__name">
              <img :src="withBase('/logo.svg')" alt="" width="48" height="48" />
              <b>BLE Scale Sync</b>
            </div>
            <div class="bss-read">
              <span class="bss-read__w">78.42<small> kg</small></span>
              <dl>
                <div>
                  <dt>Body fat</dt>
                  <dd>18.6 %</dd>
                </div>
                <div>
                  <dt>Water</dt>
                  <dd>56.9 %</dd>
                </div>
                <div>
                  <dt>Muscle</dt>
                  <dd>60.71 kg</dd>
                </div>
              </dl>
            </div>
            <div class="bss-hub__runs">
              <img
                v-for="r in runsOn"
                :key="r.name"
                :src="icon(r.icon)"
                :alt="r.name"
                :title="r.name"
                width="20"
                height="20"
              />
            </div>
            <a class="bss-link" :href="withBase('/body-composition')">See the formulas</a>
          </div>
          <svg
            class="bss-flow__lines"
            :viewBox="`0 0 100 ${outH}`"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              v-for="(y, i) in outY"
              :key="i"
              :d="curve(outH / 2, y)"
              pathLength="1"
              style="--ld: 0.9s"
            />
            <circle
              v-for="(y, i) in outY"
              :key="'q' + i"
              r="2.2"
              class="bss-pulse"
              :style="{
                '--pd': `${1.4 + i * 1.4}s`,
                offsetPath: `path('${curve(outH / 2, y)}')`,
              }"
            />
          </svg>
          <div class="bss-flow__col bss-flow__col--out">
            <span class="bss-flow__head">Sent to</span>
            <div
              v-for="(g, i) in groups"
              :key="g.name"
              class="bss-group"
              :style="{ '--pd': `${1.4 + i * 1.4}s` }"
            >
              <span class="bss-group__name">{{ g.name }}</span>
              <div class="bss-group__items">
                <a v-for="t in g.items" :key="t.name" class="bss-target" :href="withBase(t.link)">
                  <img :src="icon(t.icon)" alt="" width="16" height="16" />{{ t.name }}
                </a>
              </div>
            </div>
          </div>
        </div>
        <p class="bss-foot">
          Each user gets their own targets, picked by weight when several people share one scale.
          <a class="bss-link" :href="withBase('/exporters')">See every export target</a>
        </p>
      </div>
    </section>

    <section id="quick-start" class="bss-sec bss-install" aria-labelledby="bss-install">
      <div class="bss-wrap">
        <h2 id="bss-install">Install on the machine near your scale</h2>
        <div class="bss-install__grid">
          <div class="bss-cards">
            <div v-for="c in installs" :key="c.name" class="bss-icard">
              <img :src="icon(c.icon)" alt="" width="28" height="28" />
              <div class="bss-icard__body">
                <h3>
                  <a class="bss-icard__link" :href="withBase(c.link)">{{ c.name }}</a>
                </h3>
                <p>{{ c.where }}</p>
                <a v-if="c.badge" class="bss-badge" :href="haRepo">
                  <img
                    src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg"
                    alt="Add the BLE Scale Sync repository to your Home Assistant"
                    height="32"
                  />
                </a>
                <div v-else class="bss-cmd">
                  <code :title="c.show ? c.cmd : undefined">{{ c.show ?? c.cmd }}</code>
                  <button type="button" class="bss-copy" @click="copy(c.cmd)">
                    {{ copied === c.cmd ? 'Copied' : 'Copy' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div
            class="bss-wiz"
            role="img"
            aria-label="The setup wizard finds a Xiaomi Mi Scale 2 and asks which export targets to use"
          >
            <div class="bss-term__bar" aria-hidden="true">
              <span class="bss-dots"><i></i><i></i><i></i></span>
              <span>ble-scale-sync setup</span>
            </div>
            <div class="bss-wiz__body" aria-hidden="true">
              <div
                v-for="(w, i) in wizard"
                :key="i"
                class="bss-wiz__ln"
                :class="w.k && `is-${w.k}`"
              >
                {{ w.text }}
              </div>
            </div>
          </div>
        </div>
        <div class="bss-close">
          <p>
            Free and open source under GPL-3.0. Measurements go only to the targets you configure.
            The setup wizard finds the scale and writes <code>config.yaml</code>.
          </p>
          <a class="bss-btn bss-btn--primary" :href="withBase('/guide/getting-started')"
            >Install BLE Scale Sync</a
          >
        </div>
        <p class="bss-legal">Product names and logos are trademarks of their owners.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.bss {
  --bss-bg: var(--vp-c-bg);
  --bss-surface: var(--vp-c-bg-soft);
  --bss-ink: var(--vp-c-text-1);
  --bss-muted: var(--vp-c-text-2);
  --bss-line: var(--vp-c-divider);
  --bss-action: #2563eb;
  --bss-action-hover: #1d4ed8;
  --bss-action-ink: #ffffff;
  --bss-inv-bg: #0f172a;
  --bss-inv-ink: #f8fafc;
  --bss-inv-muted: #a3acbd;
  --bss-inv-line: rgba(248, 250, 252, 0.14);
  --bss-lit: radial-gradient(120% 90% at 85% 10%, #dbeafe 0%, #eef4ff 45%, #f4f7fb 100%);
  --bss-gut: 80px;
  --bss-padt: 120px;
  --bss-padb: 72px;
  --bss-r-lg: 20px;
  --bss-r-md: 12px;
  --bss-r-btn: 8px;
  --bss-font: 'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif;
  --bss-mono: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --p-bg: var(--bss-bg);
  --p-inv-bg: var(--bss-inv-bg);
  --accent: #60a5fa;
  --r-lg: var(--bss-r-lg);
  background: var(--bss-bg);
  color: var(--bss-ink);
  font-family: var(--bss-font);
  font-stretch: 96%;
}
:global(.dark .bss) {
  --bss-action: #3b82f6;
  --bss-action-hover: #2563eb;
  --bss-inv-bg: #0b1222;
  --bss-lit: radial-gradient(120% 90% at 85% 10%, #1e3a5f 0%, #172235 50%, #141821 100%);
}

.bss-sec {
  box-sizing: border-box;
  /* At least one screen, and taller when a short desktop (1366x768) needs it. */
  min-height: 100svh;
  padding: var(--bss-padt) 0 var(--bss-padb);
}
.bss-wrap {
  box-sizing: border-box;
  width: min(100% - 2 * var(--bss-gut), 1280px);
  margin: 0 auto;
}
.bss-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  column-gap: 24px;
}

h1,
h2,
h3 {
  font-family: var(--bss-font);
  font-weight: 500;
  color: inherit;
  margin: 0;
  border: 0;
  padding: 0;
}
h1 {
  font-size: 64px;
  line-height: 1.02;
  letter-spacing: -0.036em;
}
h2 {
  font-size: 48px;
  line-height: 1.08;
  letter-spacing: -0.028em;
  max-width: 22ch;
}
h3 {
  font-size: 20px;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.bss-muted {
  color: var(--bss-muted);
}

/* Hero: text span-5, lit frame span-6 start-7 with the log window cut by its right and bottom edges. */
.bss-hero {
  min-height: 0;
  height: calc(100svh - var(--vp-nav-height));
  padding-top: 56px;
  padding-bottom: 64px;
}
.bss-hero .bss-grid {
  height: 100%;
}
.bss-hero__text {
  grid-column: 1 / span 5;
  align-self: start;
}
.bss-lead {
  margin: 24px 0 0;
  font-size: 20px;
  line-height: 30px;
  color: var(--bss-ink);
  max-width: 34em;
}
.bss-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}
.bss-proof {
  margin: 24px 0 0;
  font-size: 16px;
  line-height: 24px;
  color: var(--bss-ink);
}
.bss-stats {
  display: flex;
  gap: 40px;
  margin: 40px 0 0;
  padding-top: 24px;
  border-top: 1px solid var(--bss-line);
}
.bss-stats div {
  display: flex;
  flex-direction: column-reverse;
}
.bss-stats dd {
  margin: 0;
  font-size: 36px;
  line-height: 1.1;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.bss-stats dt {
  font-size: 14px;
  line-height: 20px;
  color: var(--bss-muted);
}

/* The log window is cut by the frame's right edge; the result cards sit under it. */
.bss-hero__art {
  grid-column: 7 / span 6;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  max-height: 716px;
  box-sizing: border-box;
  padding: 56px 32px 32px 56px;
  border-radius: var(--bss-r-lg);
  background: var(--bss-lit);
  overflow: hidden;
}
.bss-term {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin-right: -60px;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: var(--bss-r-md);
  border: 1px solid rgba(15, 23, 42, 0.18);
  font-family: var(--bss-mono);
  font-size: 13px;
  line-height: 22px;
  overflow: hidden;
}
.bss-term__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 16px;
  color: #94a3b8;
  border-bottom: 1px solid rgba(248, 250, 252, 0.08);
}
.bss-dots {
  display: inline-flex;
  gap: 6px;
}
.bss-dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #334155;
}
/* Newest line at the bottom; older lines leave by the top edge. */
.bss-term__body {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 16px 80px 16px 20px;
}
.bss-term__ln {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bss-term__t {
  color: #64748b;
  margin-right: 12px;
}
.bss-term__s {
  color: #7dd3fc;
  margin-right: 8px;
}
.bss-term__ln.is-ok .bss-term__m {
  color: #86efac;
}

.bss-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bss-result {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bss-bg);
  color: var(--bss-ink);
  border: 1px solid var(--bss-line);
  border-radius: var(--bss-r-md);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.1);
  font-size: 14px;
  line-height: 20px;
  opacity: 0.35;
  transform: translateY(6px);
  transition:
    opacity 0.4s ease,
    transform 0.4s ease;
}
.bss-result.is-on {
  opacity: 1;
  transform: none;
}
.bss-result img {
  flex: none;
  padding: 2px;
  box-sizing: content-box;
  background: #fff;
  border-radius: 4px;
}
.bss-result b {
  font-weight: 500;
  white-space: nowrap;
}
.bss-result__d {
  flex: 1;
  min-width: 0;
  color: var(--bss-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bss-chip {
  font-size: 13px;
  line-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--bss-surface);
  color: var(--bss-muted);
  transition:
    background 0.3s,
    color 0.3s;
}
.bss-chip.is-on {
  background: #dcfce7;
  color: #166534;
}
/* Buttons: solid, one pair, step on hover, press on click. */
.bss-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  padding: 0 24px;
  border-radius: var(--bss-r-btn);
  font-size: 16px;
  font-weight: 500;
  text-decoration: none;
  transition:
    transform 0.16s ease,
    background-color 0.16s ease,
    border-color 0.16s ease;
}
.bss-btn:hover {
  transform: translateY(-1px);
}
.bss-btn:active {
  transform: translateY(1px) scale(0.98);
}
.bss-btn--primary {
  background: var(--bss-action);
  color: var(--bss-action-ink);
}
.bss-btn--primary:hover {
  background: var(--bss-action-hover);
}
.bss-btn--secondary {
  background: transparent;
  color: var(--bss-ink);
  border: 1px solid var(--bss-line);
}
.bss-btn--secondary:hover {
  border-color: var(--bss-ink);
}
.bss-btn:focus-visible,
.bss-link:focus-visible,
.bss-node:focus-visible,
.bss-icard__link:focus-visible,
.bss-badge:focus-visible,
.bss-target:focus-visible,
.bss-copy:focus-visible {
  outline: 2px solid var(--bss-action);
  outline-offset: 2px;
}

.bss-link {
  color: inherit;
  font-weight: 500;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
  text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
  transition: text-decoration-color 0.2s;
}
.bss-link:hover {
  text-decoration-color: currentColor;
}

/* Dataflow band on the inverse ground. */
.bss-band {
  /* Sized by its content, not a full screen. */
  min-height: 0;
  padding: 88px 0 72px;
  background: var(--bss-inv-bg);
  color: var(--bss-inv-ink);
  --bss-muted: var(--bss-inv-muted);
}
.bss-h2-line {
  display: block;
}
.bss-intro {
  margin: 16px 0 0;
  max-width: 62ch;
  font-size: 18px;
  line-height: 28px;
  color: var(--bss-inv-muted);
}
.bss-intro .bss-link,
.bss-foot .bss-link {
  color: var(--bss-inv-ink);
  margin-left: 4px;
}
.bss-flow {
  position: relative;
  display: grid;
  grid-template-columns:
    minmax(0, 1.4fr) minmax(0, 0.4fr) minmax(0, 2.6fr) minmax(0, 0.4fr) minmax(0, 2.6fr)
    minmax(0, 0.4fr) minmax(0, 4.7fr);
  margin-top: 56px;
}
.bss-scale {
  align-self: center;
}
.bss-scale img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--bss-r-lg);
  /* The render's own navy ground fades into the band. */
  mask-image: radial-gradient(closest-side, #000 70%, transparent 100%);
}
.bss-flow__col {
  position: relative;
  display: grid;
  gap: 8px;
  align-self: center;
}
.bss-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px;
  border: 1px solid var(--bss-inv-line);
  border-radius: var(--bss-r-md);
  background: rgba(248, 250, 252, 0.04);
}
/* A group lights up when its pulse arrives; same period and delay as the pulse. */
.bss-band:not(.is-armed) .bss-group,
.bss-band.is-in .bss-group {
  animation: bss-glow 5.6s ease-in-out calc(var(--pd) + 1.6s) infinite;
}
@keyframes bss-glow {
  0%,
  44%,
  70%,
  100% {
    border-color: var(--bss-inv-line);
    background-color: rgba(248, 250, 252, 0.04);
  }
  52% {
    border-color: rgba(147, 197, 253, 0.6);
    background-color: rgba(147, 197, 253, 0.1);
  }
}
.bss-group__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--bss-inv-muted);
}
.bss-group__items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.bss-target {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--bss-inv-ink);
  font-size: 15px;
  line-height: 24px;
  text-decoration: none;
  transition: color 0.2s ease;
}
.bss-target:hover {
  color: #93c5fd;
}
.bss-target img {
  flex: none;
  padding: 2px;
  box-sizing: content-box;
  background: #fff;
  border-radius: 4px;
}
.bss-flow__head {
  position: absolute;
  bottom: calc(100% + 8px);
  font-size: 13px;
  font-weight: 500;
  color: var(--bss-inv-muted);
}
.bss-node {
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: 44px;
  padding: 0 14px;
  border: 1px solid var(--bss-inv-line);
  border-radius: var(--bss-r-md);
  background: rgba(248, 250, 252, 0.04);
  color: var(--bss-inv-ink);
  font-size: 16px;
  text-decoration: none;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease;
}
.bss-node:hover {
  transform: translateY(-2px);
  border-color: rgba(248, 250, 252, 0.4);
}
.bss-node img {
  flex: none;
  padding: 3px;
  box-sizing: content-box;
  background: #fff;
  border-radius: 6px;
}
.bss-flow__lines {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.bss-flow__lines--left {
  align-self: center;
  height: 200px;
}
.bss-flow__lines path {
  fill: none;
  stroke: rgba(148, 197, 255, 0.35);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
/* Pulses run once every 5.6 s, each line in turn, after the lines have drawn. */
.bss-pulse {
  fill: #93c5fd;
  offset-distance: 0%;
  opacity: 0;
}
.bss-band:not(.is-armed) .bss-pulse,
.bss-band.is-in .bss-pulse {
  animation: bss-run 5.6s linear calc(var(--pd) + 1.6s) infinite;
}
@keyframes bss-run {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  6% {
    opacity: 1;
  }
  44% {
    opacity: 1;
  }
  50%,
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}

/* Draw-in: lines trace from the scale to the targets, the boxes rise in step. */
.bss-band.is-armed .bss-flow__lines path {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transition: stroke-dashoffset 0.8s ease var(--ld);
}
.bss-band.is-armed.is-in .bss-flow__lines path {
  stroke-dashoffset: 0;
}
.bss-band.is-armed .bss-scale,
.bss-band.is-armed .bss-node,
.bss-band.is-armed .bss-hub,
.bss-band.is-armed .bss-group {
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 0.5s ease var(--rd, 0s),
    transform 0.5s ease var(--rd, 0s),
    border-color 0.2s ease;
}
.bss-band.is-armed .bss-node {
  --rd: 0.35s;
}
.bss-band.is-armed .bss-hub {
  --rd: 0.8s;
}
.bss-band.is-armed .bss-group {
  --rd: 1.2s;
}
.bss-band.is-armed.is-in .bss-scale,
.bss-band.is-armed.is-in .bss-node,
.bss-band.is-armed.is-in .bss-hub,
.bss-band.is-armed.is-in .bss-group {
  opacity: 1;
  transform: none;
}
.bss-band.is-armed.is-in .bss-node:hover {
  transform: translateY(-2px);
}
/* The hub is the product: the largest box, lit in the brand blue. */
.bss-hub {
  position: relative;
  z-index: 1;
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px;
  border-radius: var(--bss-r-lg);
  background: linear-gradient(160deg, #1e3a8a 0%, #172554 55%, #111b3a 100%);
  border: 1px solid rgba(147, 197, 253, 0.55);
  box-shadow:
    0 0 0 6px rgba(59, 130, 246, 0.08),
    0 24px 64px rgba(37, 99, 235, 0.35);
}
.bss-hub__name {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bss-hub__name img {
  flex: none;
  border-radius: 10px;
}
.bss-hub__name b {
  font-size: 22px;
  line-height: 1.2;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.bss-read {
  padding: 12px 0;
  border-top: 1px solid var(--bss-inv-line);
  border-bottom: 1px solid var(--bss-inv-line);
}
.bss-read__w {
  display: block;
  font-size: 36px;
  line-height: 1.1;
  font-weight: 500;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.bss-read__w small {
  font-size: 18px;
  color: var(--bss-inv-muted);
}
.bss-read dl {
  margin: 8px 0 0;
}
.bss-read dl div {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  line-height: 22px;
}
.bss-read dt {
  color: var(--bss-inv-muted);
}
.bss-read dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.bss-hub__runs {
  display: flex;
  gap: 8px;
}
.bss-hub__runs img {
  padding: 4px;
  box-sizing: content-box;
  background: #fff;
  border-radius: 6px;
}
.bss-hub .bss-link {
  font-size: 15px;
  color: var(--bss-inv-ink);
}
.bss-foot {
  margin: 32px 0 0;
  font-size: 16px;
  line-height: 26px;
  color: var(--bss-inv-muted);
}

/* Install: three ways in a column, the setup wizard beside them. */
.bss-install__grid {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: 24px;
  margin-top: 48px;
  align-items: stretch;
}
.bss-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bss-icard {
  position: relative;
  display: flex;
  gap: 16px;
  padding: 20px 24px;
  border-radius: var(--bss-r-lg);
  background: var(--bss-surface);
  color: var(--bss-ink);
  transition: transform 0.2s ease;
}
.bss-icard:has(.bss-icard__link:hover) {
  transform: translateY(-2px);
}
.bss-icard > img {
  flex: none;
  align-self: flex-start;
  padding: 6px;
  box-sizing: content-box;
  background: #fff;
  border-radius: 8px;
}
.bss-icard__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.bss-icard__link {
  color: inherit;
  text-decoration: none;
}
/* The whole card opens the guide; the badge and the copy button sit above that layer. */
.bss-icard__link::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}
.bss-icard p {
  margin: 0;
  font-size: 15px;
  line-height: 24px;
  color: var(--bss-ink);
}
.bss-badge {
  position: relative;
  z-index: 1;
  align-self: flex-start;
  margin-top: 4px;
  height: 32px;
}
.bss-badge img {
  display: block;
  height: 32px;
  width: auto;
}
.bss-cmd {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  padding: 6px 6px 6px 12px;
  border: 1px solid var(--bss-line);
  border-radius: var(--bss-r-btn);
  background: var(--bss-bg);
}
.bss-cmd code {
  flex: 1;
  min-width: 0;
  padding: 0;
  background: none;
  font-family: var(--bss-mono);
  font-size: 13px;
  line-height: 20px;
  color: var(--bss-ink);
  overflow-wrap: anywhere;
}
.bss-copy {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--bss-line);
  border-radius: 6px;
  background: var(--bss-surface);
  color: var(--bss-ink);
  font: 500 13px/1 var(--bss-font);
  cursor: pointer;
  transition:
    transform 0.16s ease,
    border-color 0.16s ease;
}
.bss-copy:hover {
  border-color: var(--bss-ink);
}
.bss-copy:active {
  transform: scale(0.96);
}
.bss-wiz {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--bss-r-lg);
  background: #0f172a;
  color: #e2e8f0;
  overflow: hidden;
}
.bss-wiz__body {
  flex: 1;
  padding: 16px 0 16px 20px;
  font-family: var(--bss-mono);
  font-size: 13px;
  line-height: 20px;
  overflow: hidden;
}
.bss-wiz__ln {
  min-height: 20px;
  white-space: pre;
}
.bss-wiz__ln.is-a,
.bss-wiz__ln.is-ok {
  color: #86efac;
}
.bss-wiz__ln.is-q {
  color: #7dd3fc;
}
.bss-wiz__ln.is-dim,
.bss-wiz__ln.is-off {
  color: #64748b;
}
.bss-wiz__ln.is-sel {
  color: #e2e8f0;
}
.bss-close code {
  font-family: var(--bss-mono);
  font-size: 0.85em;
}
.bss-close {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-top: 64px;
}
.bss-close p {
  margin: 0;
  font-size: 20px;
  line-height: 30px;
  max-width: 36em;
}
.bss-legal {
  margin: 32px 0 0;
  font-size: 13px;
  color: var(--bss-muted);
}

/* Hero entrance once on load. */
[data-enter] .bss-hero__text > *,
[data-enter] .bss-hero__art {
  animation: bss-enter 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}
[data-enter] .bss-hero__text > :nth-child(2) {
  animation-delay: 0.06s;
}
[data-enter] .bss-hero__text > :nth-child(3) {
  animation-delay: 0.12s;
}
[data-enter] .bss-hero__text > :nth-child(4) {
  animation-delay: 0.18s;
}
[data-enter] .bss-hero__art {
  animation-delay: 0.14s;
}
@keyframes bss-enter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
}

/* Under 1400px there is no room for the scale beside four columns; it comes back
   stacked on a tablet. */
@media (max-width: 1399px) {
  .bss-flow {
    grid-template-columns:
      minmax(0, 2.9fr) minmax(0, 0.4fr) minmax(0, 2.6fr) minmax(0, 0.4fr)
      minmax(0, 5.3fr);
  }
  .bss-hub {
    padding: 22px;
  }
  .bss-hub__name img {
    width: 40px;
    height: 40px;
  }
  .bss-hub__name b {
    font-size: 18px;
  }
  .bss-scale,
  .bss-flow__lines--scale {
    display: none;
  }
}

@media (max-width: 1279px) {
  .bss {
    --bss-gut: 48px;
  }
  h1 {
    font-size: 52px;
  }
  .bss-stats {
    gap: 28px;
  }
  .bss-stats dd {
    font-size: 30px;
  }
  .bss-node,
  .bss-target {
    font-size: 14px;
  }
  .bss-group {
    padding: 12px;
  }
  .bss-group__items {
    gap: 6px 14px;
  }
}

/* Tablet: the split stacks, text first, the frame takes what is left. */
@media (max-width: 1023px) {
  /* Stacked, the hero grows with its content instead of one fixed screen. */
  .bss-hero {
    height: auto;
    min-height: calc(100svh - var(--vp-nav-height));
  }
  .bss-hero .bss-grid {
    display: flex;
    flex-direction: column;
  }
  .bss-hero__art {
    flex: 1;
    min-height: 440px;
    margin-top: 40px;
    padding: 32px 24px 24px 32px;
  }
  h2 {
    font-size: 40px;
  }
  .bss-flow {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .bss-flow__lines {
    display: none;
  }
  .bss-scale {
    display: block;
    width: 160px;
  }
  .bss-flow__col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: none;
    gap: 8px;
  }
  .bss-group {
    margin: 0;
  }
  .bss-flow__head {
    position: static;
    grid-column: 1 / -1;
  }
  .bss-node {
    height: auto;
    min-height: 44px;
  }
  .bss-install__grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .bss-close {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 639px) {
  .bss-band {
    padding: 64px 0 48px;
  }
  .bss {
    --bss-gut: 24px;
    --bss-padt: 96px;
    --bss-padb: 48px;
  }
  .bss-hero {
    padding-top: 32px;
    padding-bottom: 24px;
  }
  h1 {
    font-size: 38px;
    line-height: 1.05;
  }
  h2 {
    font-size: 30px;
  }
  .bss-lead {
    font-size: 18px;
    line-height: 28px;
  }
  .bss-btns {
    flex-direction: column;
  }
  .bss-btn {
    width: 100%;
  }
  .bss-proof {
    display: none;
  }
  .bss-stats {
    margin-top: 28px;
    padding-top: 16px;
    gap: 20px;
  }
  .bss-stats dd {
    font-size: 24px;
  }
  .bss-stats dt {
    font-size: 13px;
    line-height: 18px;
  }
  .bss-hero__art {
    min-height: 340px;
    margin-top: 32px;
    padding: 16px 16px 16px 16px;
  }
  .bss-term {
    margin-right: -32px;
  }
  .bss-result__d {
    display: none;
  }
  .bss-result b {
    flex: 1;
  }
  .bss-icard {
    padding: 16px;
  }
  .bss-term__t,
  .bss-term__ln.is-detail {
    display: none;
  }
  .bss-flow__col {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-enter] .bss-hero__text > *,
  [data-enter] .bss-hero__art {
    animation: none;
  }
  .bss-band .bss-pulse,
  .bss-band .bss-group {
    animation: none;
  }
  .bss-btn,
  .bss-node,
  .bss-icard,
  .bss-result {
    transition: none;
  }
}
</style>
