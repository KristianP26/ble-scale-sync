import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { QnScaleAdapter } from './qn-scale.js';
import { RenphoScaleAdapter } from './renpho.js';
import { RenphoEs26bbAdapter } from './renpho-es26bb.js';
import { MiScale2Adapter } from './mi-scale-2.js';
import { YunmaiScaleAdapter } from './yunmai.js';
import { BeurerSanitasScaleAdapter } from './beurer-sanitas.js';
import { SanitasSbf72Adapter } from './sanitas-sbf72.js';
import { SoehnleScaleAdapter } from './soehnle.js';
import { MedisanaBs44xAdapter } from './medisana-bs44x.js';
import { TrisaAdapter } from './trisa.js';
import { EsCs20mAdapter } from './es-cs20m.js';
import { RenphoBroadcastAdapter } from './renpho-broadcast.js';
import { ExingtechY1Adapter } from './exingtech-y1.js';
import { ExcelvanCF369Adapter } from './excelvan-cf369.js';
import { HesleyScaleAdapter } from './hesley.js';
import { InlifeScaleAdapter } from './inlife.js';
import { DigooScaleAdapter } from './digoo.js';
import { OneByoneAdapter, OneByoneNewAdapter } from './one-byone.js';
import { ActiveEraAdapter } from './active-era.js';
import { MgbAdapter } from './mgb.js';
import { HoffenAdapter } from './hoffen.js';
import { SenssunAdapter } from './senssun.js';
import { StandardGattScaleAdapter } from './standard-gatt.js';

export const adapters: ScaleAdapter[] = [
  // Specific adapters first — they match by device name before the generic one.
  // Order matters: SenssunAdapter before QnScaleAdapter (QN matches 'senssun'),
  // QnScaleAdapter before RenphoScaleAdapter (mutual exclusion by service UUID).
  new SenssunAdapter(),
  new QnScaleAdapter(),
  new RenphoScaleAdapter(),
  new RenphoEs26bbAdapter(),
  new MiScale2Adapter(),
  new YunmaiScaleAdapter(),
  new BeurerSanitasScaleAdapter(),
  new SanitasSbf72Adapter(),
  new SoehnleScaleAdapter(),
  new MedisanaBs44xAdapter(),
  new TrisaAdapter(),
  new RenphoBroadcastAdapter(),
  new EsCs20mAdapter(),
  new ExingtechY1Adapter(),
  new ExcelvanCF369Adapter(),
  new HesleyScaleAdapter(),
  new InlifeScaleAdapter(),
  new DigooScaleAdapter(),
  new OneByoneAdapter(),
  new OneByoneNewAdapter(),
  new ActiveEraAdapter(),
  new MgbAdapter(),
  new HoffenAdapter(),
  // Generic standard GATT adapter last — matches by service UUID / brand names
  new StandardGattScaleAdapter(),
];
