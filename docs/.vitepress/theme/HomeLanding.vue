<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

// Lines from a real run: every message below is printed by src/ as written
// (run.ts, ble/shared.ts, runtime/processor.ts, orchestrator.ts, exporters/).
// Only the timestamp is shortened to the time of day.
const log: { t: string; scope: string; msg: string; ok?: boolean }[] = [
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
  { t: '07:12:16', scope: 'Sync', msg: 'Exporting to: garmin, mqtt...' },
  { t: '07:12:19', scope: 'Garmin', msg: 'Garmin upload succeeded.', ok: true },
  {
    t: '07:12:19',
    scope: 'MQTT',
    msg: 'Published to scale/body-composition (qos=1, retain=true).',
    ok: true,
  },
  { t: '07:12:19', scope: 'Sync', msg: 'Waiting 30s before next scan...' },
  { t: '07:12:49', scope: 'Sync', msg: 'Scanning for any recognized scale...' },
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
      { name: 'Garmin Connect', icon: 'garmin', link: '/exporters#garmin' },
      { name: 'Strava', icon: 'strava', link: '/exporters#strava' },
      { name: 'Intervals.icu', icon: 'intervals', link: '/exporters#intervals' },
      { name: 'Runalyze', icon: 'runalyze', link: '/exporters#runalyze' },
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

const installs: {
  name: string;
  icon: string;
  where: string;
  cmd: string;
  link: string;
  badge?: boolean;
}[] = [
  {
    name: 'Docker container',
    icon: 'docker',
    where: 'Linux, including Raspberry Pi and NAS.',
    cmd: 'docker compose up -d',
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

// Both sides are four equal rows, so in the 400-unit tall line art (stretched to
// the row height) each row's centre sits at 50, 150, 250 and 350.
const flowH = 400;
const rowsY = [50, 150, 250, 350];
const curve = (a: number, b: number) => `M0 ${a} C 50 ${a}, 50 ${b}, 100 ${b}`;

const haRepo =
  'https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync';

const icon = (id: string) => withBase(`/icons/${id}.svg`);

// The result card replays its three steps on load and when the pointer enters.
const step = ref(3);
let timers: ReturnType<typeof setTimeout>[] = [];
const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function replay() {
  if (reduced()) return;
  timers.forEach(clearTimeout);
  step.value = 0;
  timers = [1, 2, 3].map((n) => setTimeout(() => (step.value = n), 500 + n * 700));
}

const band = ref<HTMLElement | null>(null);
let moment: { destroy?: () => void } | null = null;

onMounted(async () => {
  setTimeout(replay, 1800);
  // The dealt scroll moment is the taste-skill kit's own module, loaded as a
  // plain file so it stays out of the docs bundle.
  try {
    (window as unknown as { __momentsManual: boolean }).__momentsManual = true;
    const url = withBase('/taste/moments/moments.js');
    const m = await import(/* @vite-ignore */ url);
    if (band.value) moment = await m.mount(band.value);
  } catch {
    // The section reads the same without the moment.
  }
});

onBeforeUnmount(() => {
  timers.forEach(clearTimeout);
  moment?.destroy?.();
  if (band.value) delete (band.value as unknown as { __momentP?: unknown }).__momentP;
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
        </div>

        <div
          class="bss-hero__art"
          role="img"
          aria-label="BLE Scale Sync log: a weigh-in of 78.42 kg read over Bluetooth, its body composition, and the upload to Garmin Connect and MQTT"
          @mouseenter="replay"
        >
          <div class="bss-term" aria-hidden="true">
            <div class="bss-term__bar">
              <span class="bss-dots"><i></i><i></i><i></i></span>
              <span>docker logs -f ble-scale-sync</span>
            </div>
            <div class="bss-term__body">
              <div
                v-for="(l, i) in log"
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
          <div class="bss-card" aria-hidden="true">
            <div class="bss-card__row">
              <img :src="icon('garmin')" alt="" width="20" height="20" />
              <b>Garmin Connect</b>
              <span class="bss-chip" :class="{ 'is-on': step >= 3 }">{{
                step >= 3 ? 'Uploaded' : 'Sending'
              }}</span>
            </div>
            <div class="bss-card__ln" :class="{ 'is-on': step >= 1 }">Weight 78.42 kg</div>
            <div class="bss-card__ln" :class="{ 'is-on': step >= 2 }">
              Body fat 18.6 %, muscle 60.71 kg
            </div>
            <div class="bss-card__ln" :class="{ 'is-on': step >= 3 }">Synced at 07:12:19</div>
          </div>
        </div>
      </div>
    </section>

    <section
      ref="band"
      class="bss-sec bss-band"
      aria-labelledby="bss-flow"
      data-moment="line-carries-colour"
      data-moment-opts='{"from": "base"}'
    >
      <div class="bss-wrap">
        <h2 id="bss-flow">
          From the scale to your apps. <span class="bss-muted">No phone in between.</span>
        </h2>
        <p class="bss-intro">
          Scales from Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas and Medisana are recognised from
          their Bluetooth advertisements.
          <a class="bss-link" :href="withBase('/guide/supported-scales')">See the scale list</a>
        </p>

        <div
          class="bss-flow"
          role="group"
          aria-label="How a weigh-in travels from the scale to your apps"
        >
          <div class="bss-flow__col">
            <span class="bss-flow__head">Read by</span>
            <a v-for="t in transports" :key="t.name" class="bss-node" :href="withBase(t.link)">
              <img :src="icon(t.icon)" alt="" width="20" height="20" />{{ t.name }}
            </a>
          </div>
          <svg
            class="bss-flow__lines"
            viewBox="0 0 100 400"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path v-for="y in rowsY" :key="y" :d="curve(y, flowH / 2)" />
            <circle
              v-for="(y, i) in rowsY"
              :key="'p' + y"
              r="2.2"
              class="bss-pulse"
              :style="{
                animationDelay: `${i * 0.7}s`,
                offsetPath: `path('${curve(y, flowH / 2)}')`,
              }"
            />
          </svg>
          <div class="bss-hub">
            <img :src="withBase('/logo.svg')" alt="" width="56" height="56" />
            <b>BLE Scale Sync</b>
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
            <span>Body fat, water, muscle, bone and BMR from weight and impedance</span>
            <a class="bss-link" :href="withBase('/body-composition')">See the formulas</a>
          </div>
          <svg
            class="bss-flow__lines"
            viewBox="0 0 100 400"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path v-for="y in rowsY" :key="y" :d="curve(flowH / 2, y)" />
            <circle
              v-for="(y, i) in rowsY"
              :key="'q' + y"
              r="2.2"
              class="bss-pulse"
              :style="{
                animationDelay: `${1.4 + i * 0.7}s`,
                offsetPath: `path('${curve(flowH / 2, y)}')`,
              }"
            />
          </svg>
          <div class="bss-flow__col bss-flow__col--out">
            <span class="bss-flow__head">Sent to</span>
            <div v-for="g in groups" :key="g.name" class="bss-group">
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
        <div class="bss-cards">
          <div v-for="c in installs" :key="c.name" class="bss-icard">
            <img :src="icon(c.icon)" alt="" width="32" height="32" />
            <h3>
              <a class="bss-icard__link" :href="withBase(c.link)">{{ c.name }}</a>
            </h3>
            <p>{{ c.where }}</p>
            <a v-if="c.badge" class="bss-badge" :href="haRepo">
              <img
                src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg"
                alt="Add the BLE Scale Sync repository to your Home Assistant"
                height="40"
              />
            </a>
            <code v-else>{{ c.cmd }}</code>
          </div>
        </div>
        <div class="bss-close">
          <p>
            Free and open source under GPL-3.0. Measurements go only to the targets you configure.
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
.bss-hero__art {
  grid-column: 7 / span 6;
  position: relative;
  height: 100%;
  max-height: 716px;
  border-radius: var(--bss-r-lg);
  background: var(--bss-lit);
  overflow: hidden;
}
.bss-term {
  position: absolute;
  left: 64px;
  top: 64px;
  right: -28px;
  bottom: -40px;
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
.bss-term__body {
  padding: 16px 56px 16px 20px;
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

.bss-card {
  position: absolute;
  left: 32px;
  bottom: 32px;
  width: 300px;
  padding: 16px;
  background: var(--bss-bg);
  color: var(--bss-ink);
  border: 1px solid var(--bss-line);
  border-radius: var(--bss-r-md);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.14);
  font-size: 14px;
  line-height: 20px;
}
.bss-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.bss-card__row img {
  background: #fff;
  border-radius: 4px;
}
.bss-card__row b {
  font-weight: 500;
  flex: 1;
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
.bss-card__ln {
  color: var(--bss-muted);
  opacity: 0.25;
  transform: translateY(4px);
  transition:
    opacity 0.4s,
    transform 0.4s;
}
.bss-card__ln.is-on {
  opacity: 1;
  transform: none;
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
.bss-badge:focus-visible {
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
  background: var(--bss-inv-bg);
  color: var(--bss-inv-ink);
  --bss-muted: var(--bss-inv-muted);
  /* The moment's cover runs edge to edge in the hero's ground, so the wipe reads
     as the hero lifting off the band, not as a light card framed inside it. */
  --mo-gap: 0px;
  --r-lg: 0px;
}
.bss-intro {
  margin: 24px 0 0;
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
  display: grid;
  grid-template-columns: minmax(0, 2.6fr) minmax(0, 1fr) minmax(0, 2.6fr) minmax(0, 1fr) minmax(
      0,
      5.6fr
    );
  margin-top: 48px;
}
/* Both sides are four equal rows, sized by the tallest group card, so a line
   from the hub meets the centre of each row. */
.bss-flow__col {
  position: relative;
  display: grid;
  grid-template-rows: repeat(4, 1fr);
  align-items: center;
}
.bss-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 5px 0;
  padding: 12px 16px;
  border: 1px solid var(--bss-inv-line);
  border-radius: var(--bss-r-md);
  background: rgba(248, 250, 252, 0.04);
}
.bss-group__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--bss-inv-muted);
}
.bss-group__items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
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
.bss-flow__lines path {
  fill: none;
  stroke: rgba(148, 197, 255, 0.35);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.bss-pulse {
  fill: #93c5fd;
  offset-distance: 0%;
  animation: bss-run 2.8s linear infinite;
}
@keyframes bss-run {
  from {
    offset-distance: 0%;
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  to {
    offset-distance: 100%;
    opacity: 0;
  }
}
.bss-hub {
  align-self: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  border-radius: var(--bss-r-lg);
  background: #16213a;
  border: 1px solid rgba(147, 197, 253, 0.35);
}
.bss-hub b {
  font-size: 20px;
  font-weight: 500;
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
.bss-hub span {
  font-size: 15px;
  line-height: 22px;
  color: var(--bss-inv-muted);
}
.bss-hub .bss-link {
  font-size: 15px;
  color: var(--bss-inv-ink);
}
.bss-foot {
  margin: 40px 0 0;
  font-size: 16px;
  line-height: 26px;
  color: var(--bss-inv-muted);
}

/* Install. */
.bss-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
  margin-top: 48px;
}
.bss-icard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 32px;
  border-radius: var(--bss-r-lg);
  background: var(--bss-surface);
  color: var(--bss-ink);
  text-decoration: none;
  transition: transform 0.2s ease;
}
.bss-icard:has(a:hover) {
  transform: translateY(-2px);
}
.bss-icard__link {
  color: inherit;
  text-decoration: none;
}
/* The whole card opens the guide; the badge sits above that layer. */
.bss-icard__link::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}
.bss-icard {
  position: relative;
}
.bss-badge {
  position: relative;
  z-index: 1;
  align-self: flex-start;
  margin-top: 8px;
  height: 40px;
}
.bss-icard .bss-badge img {
  display: block;
  height: 40px;
  width: auto;
  padding: 0;
  margin: 0;
  background: none;
}
.bss-icard img {
  padding: 6px;
  box-sizing: content-box;
  background: #fff;
  border-radius: 8px;
  margin-bottom: 8px;
}
.bss-icard p {
  margin: 0;
  font-size: 16px;
  line-height: 26px;
  color: var(--bss-ink);
  flex: 1;
}
.bss-icard code {
  display: block;
  margin-top: 8px;
  padding: 0;
  background: none;
  font-family: var(--bss-mono);
  font-size: 13px;
  line-height: 20px;
  color: var(--bss-ink);
  overflow-wrap: anywhere;
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

@media (max-width: 1279px) {
  .bss {
    --bss-gut: 48px;
  }
  h1 {
    font-size: 52px;
  }
  .bss-flow {
    grid-template-columns: minmax(0, 3fr) minmax(0, 0.6fr) minmax(0, 2.2fr) minmax(0, 0.6fr) minmax(
        0,
        5.8fr
      );
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
  .bss-hero .bss-grid {
    display: flex;
    flex-direction: column;
  }
  .bss-hero__art {
    flex: 1;
    min-height: 260px;
    margin-top: 40px;
  }
  .bss-term {
    left: 32px;
    top: 32px;
  }
  .bss-card {
    display: none;
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
  .bss-cards {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .bss-icard {
    padding: 24px;
  }
  .bss-close {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 639px) {
  .bss {
    --bss-gut: 24px;
    --bss-padt: 96px;
    --bss-padb: 48px;
  }
  .bss-hero {
    height: calc(100svh - var(--vp-nav-height));
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
  .bss-card {
    display: none;
  }
  .bss-hero__art {
    min-height: 220px;
    margin-top: 32px;
  }
  .bss-term {
    left: 16px;
    top: 16px;
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
  .bss-pulse {
    animation: none;
    opacity: 0;
  }
  .bss-btn,
  .bss-node,
  .bss-icard,
  .bss-card__ln {
    transition: none;
  }
}
</style>
