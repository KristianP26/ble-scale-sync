import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { QnScaleAdapter } from './qn-scale.js';
import { RenphoScaleAdapter } from './renpho.js';
import { RenphoEs26bbAdapter } from './renpho-es26bb.js';
import { MiScale2Adapter } from './mi-scale-2.js';
import { XiaomiS800Adapter } from './xiaomi-s800.js';
import { BeurerBf720Adapter } from './beurer-bf720.js';
import { YunmaiScaleAdapter } from './yunmai.js';
import { BeurerSanitasScaleAdapter } from './beurer-sanitas.js';
import { SanitasSbf72Adapter } from './sanitas-sbf72.js';
import { SoehnleScaleAdapter } from './soehnle.js';
import { MedisanaBs44xAdapter } from './medisana-bs44x.js';
import { TrisaAdapter } from './trisa.js';
import { EsCs20mAdapter } from './es-cs20m.js';

import { ExingtechY1Adapter } from './exingtech-y1.js';
import { ExcelvanCF369Adapter } from './excelvan-cf369.js';
import { HesleyScaleAdapter } from './hesley.js';
import { InlifeScaleAdapter } from './inlife.js';
import { DigooScaleAdapter } from './digoo.js';
import { OneByoneAdapter, OneByoneNewAdapter } from './one-byone.js';
import { ActiveEraAdapter } from './active-era.js';
import { RobiS9Adapter } from './robi-s9.js';
import { HutbitAdapter } from './hutbit.js';
import { MgbAdapter } from './mgb.js';
import { HoffenAdapter } from './hoffen.js';
import { SenssunAdapter } from './senssun.js';
import { EufyP2Adapter } from './eufy-p2.js';
import { StandardGattScaleAdapter } from './standard-gatt.js';
import { registerExclusionRegistry } from './derived-excludes.js';

export const adapters: ScaleAdapter[] = [
  // Specific adapters first — they match by device name before the generic one.
  // Order matters: SenssunAdapter before QnScaleAdapter (QN matches 'senssun'),
  // QnScaleAdapter before RenphoScaleAdapter (mutual exclusion by service UUID),
  // EufyP2Adapter before QnScaleAdapter (P2/P2 Pro advertise FFF0 and would be
  // mis-detected as a QN scale; Eufy's company ID 0xFF48 + "eufy T914x" name is specific).
  new EufyP2Adapter(),
  new SenssunAdapter(),
  new QnScaleAdapter(),
  new RenphoScaleAdapter(),
  new RenphoEs26bbAdapter(),
  // Beurer SIG scales (BF720/BF105) advertise/expose Body Composition 0x181B
  // and would otherwise be grabbed by the Mi Scale 2 adapter, so match them
  // first (by BF720/BF105 name or Beurer company id 0x0611).
  new BeurerBf720Adapter(),
  new MiScale2Adapter(),
  // Xiaomi Mijia S800 (ms116): broadcast-only, matches FE95 + product id 0x51E2
  // or its own name; no collision with any other adapter (#232).
  new XiaomiS800Adapter(),
  new YunmaiScaleAdapter(),
  new BeurerSanitasScaleAdapter(),
  new SanitasSbf72Adapter(),
  new SoehnleScaleAdapter(),
  new MedisanaBs44xAdapter(),
  new TrisaAdapter(),
  new EsCs20mAdapter(),
  new ExingtechY1Adapter(),
  new ExcelvanCF369Adapter(),
  new HesleyScaleAdapter(),
  new InlifeScaleAdapter(),
  new DigooScaleAdapter(),
  new OneByoneAdapter(),
  new OneByoneNewAdapter(),
  new ActiveEraAdapter(),
  // Robi S9 (Lefu/Fitdays FFB0-new) before MGB: both use service 0xFFB0, but the
  // Robi speaks a different protocol and is matched by name or its FFB3 result
  // characteristic, so it must win before the generic MGB FFB0 fallback (#228).
  new RobiS9Adapter(),
  // Hutbit (Lefu/Fitdays FFB0 8-byte AC02 protocol): matches by its "Hutbit"
  // name; sits before the generic MGB FFB0 fallback (#254).
  new HutbitAdapter(),
  new MgbAdapter(),
  new HoffenAdapter(),
  // Generic standard GATT adapter last — matches by service UUID / brand names
  new StandardGattScaleAdapter(),
];

// Provide the assembled registry to the generic adapter's exclusion derivation
// (StandardGattScaleAdapter excludes any name a more specific adapter claims).
registerExclusionRegistry(adapters);
