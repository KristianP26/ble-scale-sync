import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { QnScaleAdapter } from './qn-scale.js';
import { RenphoScaleAdapter } from './renpho.js';
import { RenphoEs26bbAdapter } from './renpho-es26bb.js';
import { RenphoMsc04Adapter } from './renpho-msc04.js';
import { MiScale2Adapter } from './mi-scale-2.js';
import { XiaomiMiScaleLegacyAdapter } from './xiaomi-mi-scale-legacy.js';
import { Silvergear108Adapter } from './silvergear-108.js';
import { XiaomiS800Adapter } from './xiaomi-s800.js';
import { XiaomiS400Adapter } from './xiaomi-s400.js';
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
import { KoogeekS1Adapter } from './koogeek-s1.js';
import { InlifeScaleAdapter } from './inlife.js';
import { EtekcityEsf551Adapter } from './etekcity-esf551.js';
import { DigooScaleAdapter } from './digoo.js';
import { OneByoneAdapter, OneByoneNewAdapter } from './one-byone.js';
import { ActiveEraAdapter } from './active-era.js';
import { RobiS9Adapter } from './robi-s9.js';
import { SpeedianceAdapter } from './speediance.js';
import { HutbitAdapter } from './hutbit.js';
import { MgbAdapter } from './mgb.js';
import { HoffenAdapter } from './hoffen.js';
import { SenssunAdapter } from './senssun.js';
import { EufyP2Adapter } from './eufy-p2.js';
import { SalterAdapter } from './salter.js';
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
  // Renpho R-MSC04 (#117/#265): 55AA-framed weight on service 0x1A10. Matched by
  // its exact advertised name only. It outranks ES-CS20M (which claims 0x1A10)
  // so a named R-MSC04 lands here, while a nameless 0x1A10 device still goes to
  // ES-CS20M.
  new RenphoMsc04Adapter(),
  new RenphoEs26bbAdapter(),
  // Beurer SIG scales (BF720/BF105) advertise/expose Body Composition 0x181B
  // and would otherwise be grabbed by the Mi Scale 2 adapter, so match them
  // first (by BF720/BF105 name or Beurer company id 0x0611).
  new BeurerBf720Adapter(),
  // XMTZC04HM is a distinct, weight-only 0x181D broadcast protocol. It must
  // resolve before MiScale2Adapter and StandardGattScaleAdapter.
  new XiaomiMiScaleLegacyAdapter(),
  // Silvergear 108: broadcast-only, non-connectable. Claims on the invented
  // company id 0xA0AC plus the exact 12-byte payload and its checksum, so it
  // cannot collide with anything else (#297).
  new Silvergear108Adapter(),
  new MiScale2Adapter(),
  // Xiaomi Mijia S800 (ms116): broadcast-only, matches FE95 + product id 0x51E2
  // or its own name; no collision with any other adapter (#232).
  new XiaomiS800Adapter(),
  // Xiaomi S400 (MJTZC01YM): same encrypted FE95 broadcast as the S800, told
  // apart by product id; also matches its "Xiaomi Scale S400" name.
  new XiaomiS400Adapter(),
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
  // Koogeek-S1 outranks Inlife because a Koogeek advertises the bare 0xFFF0
  // service, which Inlife's pre-connect fallback would otherwise claim (#270).
  new KoogeekS1Adapter(),
  // Etekcity outranks Inlife for the same reason Koogeek does: an ESF-551
  // exposes FFF0 with an FFF2 write and no FFF4, which is exactly Inlife's
  // post-discovery rule, and being claimed there ends the session on a read
  // timeout with no reading (#385). It matches on its advertised name only.
  new EtekcityEsf551Adapter(),
  new InlifeScaleAdapter(),
  new DigooScaleAdapter(),
  new OneByoneAdapter(),
  new OneByoneNewAdapter(),
  new ActiveEraAdapter(),
  // Robi S9 (Lefu/Fitdays FFB0-new) before MGB: both use service 0xFFB0, but the
  // Robi speaks a different protocol and is matched by name or its FFB3 result
  // characteristic, so it must win before the generic MGB FFB0 fallback (#228).
  new SpeedianceAdapter(), // before Robi: SPEED_S_* is a Lefu sibling with a fuller handshake
  new RobiS9Adapter(),
  // Hutbit (Lefu/Fitdays FFB0 8-byte AC02 protocol): matches by its "Hutbit"
  // name; sits before the generic MGB FFB0 fallback (#254).
  new HutbitAdapter(),
  new MgbAdapter(),
  new HoffenAdapter(),
  // Salter (0xFFCC "Healthcare ELectronic"): claims its own name prefix and the
  // FFCC/CCFF service pair, which no other adapter uses, so its position here is
  // presentational only — precedence comes from match.priority.
  new SalterAdapter(),
  // Generic standard GATT adapter last — matches by service UUID / brand names
  new StandardGattScaleAdapter(),
];

// Provide the assembled registry to the generic adapter's exclusion derivation
// (StandardGattScaleAdapter excludes any name a more specific adapter claims).
registerExclusionRegistry(adapters);
