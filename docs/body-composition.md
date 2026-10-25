---
title: Body Composition
description: How BLE Scale Sync computes each body composition metric, the BIA and Deurenberg formulas, and what athlete mode changes.
---

# Body Composition

BLE Scale Sync computes body composition from the weight, the impedance the scale measures through your feet, and the user's height, age and sex. Scales that compute their own values are used as they are, under the conditions on their scale pages.

## Exported Metrics

| Metric          | Unit     | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| Weight          | kg       | Scale reading                                            |
| BMI             | (none)   | Body Mass Index                                          |
| Body Fat        | %        | From impedance (BIA), from the scale, or estimated from BMI |
| Water           | %        | Total body water                                         |
| Bone Mass       | kg       | Estimated bone mineral content                           |
| Muscle Mass     | kg       | Fat-free mass minus bone, or the scale's own value       |
| Visceral Fat    | 1-59     | Internal organ fat rating                                |
| BMR             | kcal     | Basal Metabolic Rate                                     |
| Metabolic Age   | years    | Age whose BMR matches yours                              |
| Physique Rating | 1-9      | Body type from body fat and muscle ratio                 |
| Skeletal Muscle | %        | Only from a scale that reports it                        |

## Formulas {#how-it-works}

### Body Fat (BIA)

With a usable impedance, body fat comes from Bioelectrical Impedance Analysis, with height in cm and impedance in ohm:

```text
LBM = c1 * (height^2 / impedance) + c2 * weight + c3 * age + c4
Body Fat % = (weight - LBM) / weight * 100
```

|                  | c1    | c2    | c3     | c4   |
| ---------------- | ----- | ----- | ------ | ---- |
| Male             | 0.503 | 0.165 | -0.158 | 17.8 |
| Male (athlete)   | 0.637 | 0.205 | -0.180 | 12.5 |
| Female           | 0.490 | 0.150 | -0.130 | 11.5 |
| Female (athlete) | 0.550 | 0.180 | -0.150 | 8.5  |

The result is kept between 3 and 60 %.

### When an Impedance Is Ignored

An impedance below 150 ohm or above 1200 ohm is not a body measurement. It is exported as 0, and the weigh-in gets the scale's own body fat where the scale sends one, or the estimate below. A wrong value would not fail visibly; it would pin body fat to the 3 or 60 % limit. The log names the value:

```text
Impedance 4317 Ohm is not a usable measurement (150-1200 Ohm), so it is not used.
```

If your scale measures impedance and your body fat still looks like an estimate, look for that line and [report](/troubleshooting#report-an-issue) the number with what your vendor app shows.

### Body Fat Fallback (Deurenberg)

Without a usable impedance (a weight-only scale, socks, or a value outside 150 to 1200 ohm) and without a body fat from the scale, body fat is estimated from BMI, with `sex` 1 for male and 0 for female:

```text
Adults:          Body Fat % = 1.20 * BMI + 0.23 * age - 10.8 * sex - 5.4
Age 15 and under: Body Fat % = 1.51 * BMI - 0.70 * age -  3.6 * sex + 1.4
```

For athletes the result is multiplied by 0.85, and it is kept between 3 and 60 %. Water, bone mass, muscle mass, visceral fat and physique rating then follow from this estimate with the formulas below, so a weigh-in without impedance still exports every metric.

### Without the Estimate

With `estimate_body_composition: false` for a user, a weigh-in without measured body fat gets no estimate: body fat, water, bone mass, muscle mass, visceral fat and physique rating are left empty, while weight, BMI, BMR and metabolic age are exported. See [Configuration](/guide/configuration#users).

### Other Metrics

LBM is lean body mass, `weight * (1 - Body Fat % / 100)`.

| Metric        | Formula |
| ------------- | ------- |
| BMI           | `weight / height_m^2` |
| Water         | `LBM * 0.73 / weight * 100` (athlete: 0.74) |
| Bone Mass     | `LBM * 0.042` |
| Muscle Mass   | `LBM - Bone Mass` |
| Visceral Fat  | `Body Fat % * 0.55 - 4 + age * 0.08`, kept between 1 and 59; 1 at 10 % body fat or less |
| BMR           | Mifflin-St Jeor: `10*W + 6.25*H - 5*A + s`, `s` = +5 male, -161 female |
| Metabolic Age | `age + (BMR at age 25 - BMR) / 15`, at least 12 |
| Physique Rating | 1 to 9 from body fat (below 18, 18 to 25, above 25 %) and a skeletal muscle estimate of `LBM * 0.54` (athlete: 0.60) |

A scale's own BMR and body age replace the last two when it sends them with its body fat and they are plausible (500 to 5000 kcal, 12 to 120 years).

## Athlete Mode

`is_athlete: true` in a user's profile adjusts the formulas for people who train regularly. The [setup wizard](/guide/configuration#setup-wizard-recommended) asks for it.

- Lean body mass: the athlete BIA coefficients in the table above.
- Water: 74 % of lean body mass instead of 73 %.
- Physique rating: its skeletal muscle input is 60 % of lean body mass instead of 54 %.
- BMR: 5 % higher.
- Metabolic age: actual age minus 5 when it would otherwise come out above actual age.
- Deurenberg estimate: multiplied by 0.85.

Values a scale computed itself are used as they are.

## Scale-Specific Algorithms

A scale's own values are used only with a body fat value and only when every value it sends is in range. Otherwise the whole set is discarded and computed as above.

### Xiaomi Mi Scale 2 and S400 {#xiaomi-mi-scale-2-mibcs-mibfs-xmtzc05hm}

<span id="xiaomi-body-composition-scale-s400-mjtzc01ym"></span>Both broadcast weight and impedance (the S400 its 50 kHz value). Body fat, water, bone mass and visceral fat come from the Xiaomi formulas ported from [openScale](https://github.com/oliexdev/openScale); muscle mass, BMR and the rest from the formulas above. A frame without impedance gets the Deurenberg estimate. The S400 app uses a proprietary dual-frequency model, so expect small, consistent offsets from it.

### Yunmai

On firmware that sends it, the body fat the scale computed itself is used, and water, muscle, bone mass and visceral fat are derived from it with the Yunmai formulas ported from openScale. Otherwise body fat comes from the Yunmai formula, which works mostly from BMI and age; the generic BIA formula is not used. The scale computes for the profile its vendor app stored.

### Scales That Compute Their Own Composition {#arboleaf-and-other-8-electrode-qn-scales-19-byte-dialect}

<span id="renpho-r-msc04-morphoscan-nova"></span>The Arboleaf and other 19-byte QN scales and the Renpho R-MSC04 compute body composition themselves for a profile ble-scale-sync sends them. Their values are used only when that profile matches the user the weigh-in goes to; see [QN Scales](/guide/scales/qn) and [Renpho Scales](/guide/scales/renpho).

## References

- BIA: Lukaski H.C. et al. (1986), _"Assessment of fat-free mass using bioelectrical impedance measurements of the human body"_, American Journal of Clinical Nutrition
- Mifflin-St Jeor: Mifflin M.D., St Jeor S.T. et al. (1990), _"A new predictive equation for resting energy expenditure in healthy individuals"_, American Journal of Clinical Nutrition
- Deurenberg: Deurenberg P., Weststrate J.A., Seidell J.C. (1991), _"Body mass index as a measure of body fatness: age- and sex-specific prediction formulas"_, British Journal of Nutrition
