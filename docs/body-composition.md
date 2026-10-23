---
title: Body Composition
description: Body composition metrics, BIA formulas, Deurenberg fallback, and athlete mode adjustments.
head:
  - - meta
    - name: keywords
      content: body fat percentage, muscle mass calculation, bioelectrical impedance analysis, bia formula, bmi calculator, visceral fat, bone mass, body water percentage, smart scale accuracy, body composition metrics
---

# Body Composition

BLE Scale Sync calculates 10 body composition metrics from your scale's weight and impedance readings, combined with your user profile (height, age, gender).

**Impedance** is the electrical resistance measured when a small current passes through your body via the scale's electrodes (the metal pads you stand on). It's the key input for calculating body fat, muscle mass, water, and bone mass.

## Exported Metrics

| Metric              | Unit     | Description                                              |
| ------------------- | -------- | -------------------------------------------------------- |
| **Weight**          | kg / lbs | Raw scale reading (configurable via `weight_unit`)       |
| **BMI**             | (none)   | Body Mass Index                                          |
| **Body Fat**        | %        | BIA-based (requires impedance) or Deurenberg fallback    |
| **Water**           | %        | Total body water percentage                              |
| **Bone Mass**       | kg / lbs | Estimated bone mineral content                           |
| **Muscle Mass**     | kg / lbs | Fat-free mass minus bone, or the scale's own muscle %    |
| **Visceral Fat**    | 1-59     | Internal organ fat rating                                |
| **BMR**             | kcal     | Basal Metabolic Rate                                     |
| **Metabolic Age**   | years    | Metabolic age relative to BMR                            |
| **Physique Rating** | 1-9      | Body type classification based on fat % and muscle ratio |

## How It Works

### Body fat (BIA)

When impedance is available, body fat is calculated using **Bioelectrical Impedance Analysis**:

```
LBM = c1 * (height² / impedance) + c2 * weight + c3 * age + c4
Body Fat % = (weight - LBM) / weight * 100
```

The coefficients vary by gender and athlete status:

|                  | c1    | c2    | c3     | c4   |
| ---------------- | ----- | ----- | ------ | ---- |
| Male             | 0.503 | 0.165 | -0.158 | 17.8 |
| Male (athlete)   | 0.637 | 0.205 | -0.180 | 12.5 |
| Female           | 0.490 | 0.150 | -0.130 | 11.5 |
| Female (athlete) | 0.550 | 0.180 | -0.150 | 8.5  |

### When an impedance is ignored

An impedance only drives the calculation when it looks like a body. Anything
below **150 ohm** or above **1200 ohm** is refused, and the reading falls back
to the Deurenberg estimate below, unless the scale measured its own body fat.

The reason is that a wrong resistance is worse than none, and it fails
convincingly rather than obviously. A value far too high pins the 60 % ceiling.
A value far too low, which is what a missing or spurious factor of ten looks
like, drives `height² / impedance` up until lean body mass exceeds body weight,
and the result then pins the 4 % floor. Neither reads as an error; both silently
move every derived metric.

A refused impedance is exported as 0, together with the estimate, or with the
body fat the scale measured itself where it sends one (Yunmai). The value the
scale sent is in the log instead, on an info line:

```
Impedance 4317 Ohm is not a usable measurement (150-1200 Ohm), so it is not used.
```

If your scale measures impedance and your body fat still looks like a BMI
estimate, look for that line. The number in it is worth opening an issue with,
together with what your vendor app reports.

Some QN scales send their impedance scrambled and say so in their
advertisement, which the app reads before it connects. The advertisement that
reaches the app does not always carry that part. With the computer's own
Bluetooth (Linux, Windows, macOS) and through an ESPHome proxy, the app then
uses the one the same scale advertised earlier while the app has been running,
so in continuous mode and on the Home Assistant add-on a connection goes
without it only until one has carried it. Through the ESP32 MQTT proxy, and in
a single-shot run, which starts afresh each time, nothing is remembered. A
connection that got no advertisement at all has
`QN: no advertisement for this session` in the debug log. On a QN scale with
an 18-byte scale-info frame it also says so in the normal log, and an
impedance of 4096 to 4351 or 4608 to 4863 Ohm, which only a scrambled body
resistance gives, is then read unscrambled. Any other value is read as sent,
so in such a connection a scrambled one between 151 and 255, 512 and 767 or
1024 and 1200 Ohm can still be off by up to 39 Ohm.

### Body fat fallback (Deurenberg)

When impedance is not available (the scale only measures weight, you stood on it in socks, or it sent 0 or a value outside 150 to 1200 ohm), only **weight**, **BMI**, and **body fat** (estimated) are calculated. The remaining metrics (water, bone, muscle, visceral fat, physique rating) require impedance and will not be available. A weigh-in without impedance still completes and is exported with these values. For ages 15 and under the children's form of the Deurenberg equation is used.

Some scales measure body composition themselves. Their values are used only when the whole set is plausible; if one of them is missing or out of range, the app calculates the composition as above instead of mixing the two.

Body fat without impedance is estimated from BMI:

```
Body Fat % = 1.2 * BMI + 0.23 * age - 10.8 * sex - 5.4
```

Where `sex` = 1 for male, 0 for female. For athletes, the result is multiplied by 0.85.

### Other metrics

| Metric            | Formula                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| **BMI**           | `weight / height_m²`                                                         |
| **Water**         | `LBM * 0.73 / weight * 100` (athlete: 0.74)                                  |
| **Bone Mass**     | `LBM * 0.042`                                                                |
| **Muscle Mass**   | `LBM - Bone Mass`                                                            |
| **Visceral Fat**  | `Body Fat % * 0.55 - 4 + age * 0.08`                                         |
| **BMR**           | Mifflin-St Jeor: `10*W + 6.25*H - 5*A + s` where `s` = +5 male / -161 female |
| **Metabolic Age** | `age + (idealBMR - BMR) / 15`                                                |

The Arboleaf and other 8-electrode QN scales (19-byte dialect) compute BMR and a body age themselves. When their own body composition is used (see [below](#arboleaf-and-other-8-electrode-qn-scales-19-byte-dialect)), those two replace the BMR and metabolic age formulas. Every other scale gets the formulas.

## Athlete Mode

Setting `is_athlete: true` in a user's profile adjusts the formulas for people who exercise regularly. The [setup wizard](/guide/configuration#setup-wizard-recommended) asks about this during user profile creation.

Effects:

- **Lean Body Mass**: different BIA coefficients (see table above)
- **Water**: higher hydration factor (74% vs 73% of LBM)
- **Physique Rating**: its skeletal muscle input is 60% of LBM instead of 54%
- **BMR**: +5% boost
- **Metabolic Age**: set to actual age minus 5 when it would otherwise come out above actual age
- **Deurenberg**: result multiplied by 0.85

These adjustments apply to the formulas only. Values a scale computed itself are used as they are.

## Scale-Specific Algorithms

### Xiaomi Mi Scale 2 (MIBCS / MIBFS / XMTZC05HM)

The Mi Scale 2 broadcasts **raw impedance** in its BLE advertisement (service data UUID 0x181B). BLE Scale Sync reads the impedance and computes body composition using the Mi Scale algorithm: the same formulas used by the official Mi Fit / Zepp Life app, originally reverse-engineered by the [openScale](https://github.com/oliexdev/openScale) project. Results match what the scale's own display shows.

The adapter uses passive BLE advertisement decoding, so no pairing or GATT connection is required. This works on all transports including the ESPHome proxy.

If impedance is not present in a frame (e.g. the user stepped off before the BIA measurement completed), weight is still reported and body fat is estimated using the Deurenberg BMI fallback. All other body composition metrics require impedance.

### Xiaomi Body Composition Scale S400 (MJTZC01YM)

The S400 broadcasts weight plus its 50 kHz impedance (and a 250 kHz impedance and heart rate that are logged only). Body composition uses the same Xiaomi formulas as the Mi Scale 2 above. The S400's own app runs Yunmai's proprietary dual-frequency model, which no open implementation reproduces; on the same weigh-in the Xiaomi formulas land within about two points of body fat, 0.3 kg of bone mass and about 1.2 kg of the muscle mass the app's own fat and bone figures imply, while the generic BIA coefficients were more than five points of body fat away. Water and visceral fat differ by a few points either way. Expect small, consistent offsets from the app, not agreement to the decimal.

### Yunmai

The scale's final reading carries its resistance and, on firmware with protocol version 0x1E or newer, the body fat percentage the scale computed itself for the profile the vendor app stored in it. When that value is present and plausible it is used, and water, muscle, bone mass and visceral fat are derived from it with the Yunmai formulas ported from openScale. Otherwise body fat comes from the Yunmai formula ported from openScale, which works mostly from BMI and age and adjusts slightly for the resistance; when that formula gives no usable value, the BMI estimate is the fallback. Generic BIA is not used, because nothing shows that the resistance the scale sends is in ohms. BMI, BMR, metabolic age and physique rating are calculated locally. The Yunmai SE reports no impedance, so its body composition is estimated from BMI.

### Arboleaf and other 8-electrode QN scales (19-byte dialect)

These scales measure eight segment impedances (both hands, both feet and the trunk, at two frequencies) and compute body fat, water, muscle, bone and visceral fat themselves, for the profile ble-scale-sync sends before the weigh-in: the first user's age, height and sex (with `ble.qn_weight_ack` or `ble.qn_user_key`). Those values are used as one set, only when the weigh-in is matched to a user with exactly that profile and the scale measured after it accepted the profile. With them come the scale's own BMR and its body age, exported as metabolic age, each only when it is plausible (500 to 5000 kcal, 12 to 120 years); a value outside that range is calculated locally instead, on its own. BMI and physique rating are always calculated locally. Otherwise, and for weigh-ins the scale stored while nothing was connected, body composition is estimated from BMI. The segment impedances are logged in debug mode only; no whole-body impedance is derived from them. The scale reports muscle and bone as a percentage of body weight, which its display shows; they are exported in kg. Confirmed on two units ([#331](https://github.com/KristianP26/ble-scale-sync/issues/331)); the BMR and body age have been compared with the vendor app on one unit only. Details in [Supported Scales](/guide/supported-scales#arboleaf-qn-scale-19-byte-dialect).

### Renpho R-MSC04 (MorphoScan Nova)

The scale measures ten segment impedances (five segments at two frequencies) and computes body fat, BMI, skeletal muscle and visceral fat itself, for the profile last written to it. With `ble.rmsc04_profile_byte` set, its body fat and visceral fat are used, and water, muscle and bone mass are derived from that body fat; BMI, BMR, metabolic age and physique rating are calculated locally. Without the option, or when one of its conditions does not hold, body composition is estimated from BMI. The ten segment impedances are exported as diagnostic values with every record that has a body fat value, whether or not the scale's body fat is used (see [Exporters](/exporters#mqtt)); no whole-body impedance is derived from them. The skeletal muscle percentage is logged in debug mode only. The option is confirmed on one scale against the Renpho app. Details in [Supported Scales](/guide/supported-scales#renpho-r-msc04-morphoscan-nova).

## References

- **BIA**: Lukaski H.C. et al. (1986), _"Assessment of fat-free mass using bioelectrical impedance measurements of the human body"_, American Journal of Clinical Nutrition
- **Mifflin-St Jeor**: Mifflin M.D., St Jeor S.T. et al. (1990), _"A new predictive equation for resting energy expenditure in healthy individuals"_, American Journal of Clinical Nutrition
- **Deurenberg**: Deurenberg P., Weststrate J.A., Seidell J.C. (1991), _"Body mass index as a measure of body fatness: age- and sex-specific prediction formulas"_, British Journal of Nutrition
