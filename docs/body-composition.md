---
title: Body Composition
description: Body composition metrics, BIA formulas, Deurenberg fallback, and athlete mode adjustments.
---

# Body Composition

BLE Scale Sync calculates 10 body composition metrics from your scale's weight and impedance readings, combined with your user profile (height, age, gender).

**Impedance** is the electrical resistance measured when a small current passes through your body via the scale's electrodes (the metal pads you stand on). It's the key input for calculating body fat, muscle mass, water, and bone mass.

## Exported Metrics

| Metric | Unit | Description |
|---|---|---|
| **Weight** | kg / lbs | Raw scale reading (configurable via `weight_unit`) |
| **BMI** | — | Body Mass Index |
| **Body Fat** | % | BIA-based (requires impedance) or Deurenberg fallback |
| **Water** | % | Total body water percentage |
| **Bone Mass** | kg / lbs | Estimated bone mineral content |
| **Muscle Mass** | kg / lbs | Skeletal muscle mass |
| **Visceral Fat** | 1–59 | Internal organ fat rating |
| **BMR** | kcal | Basal Metabolic Rate |
| **Metabolic Age** | years | Metabolic age relative to BMR |
| **Physique Rating** | 1–9 | Body type classification based on fat % and muscle ratio |

## How It Works

### Body fat (BIA)

When impedance is available, body fat is calculated using **Bioelectrical Impedance Analysis**:

```
LBM = c1 * (height² / impedance) + c2 * weight + c3 * age + c4
Body Fat % = (weight - LBM) / weight * 100
```

The coefficients vary by gender and athlete status:

|  | c1 | c2 | c3 | c4 |
|---|---|---|---|---|
| Male | 0.503 | 0.165 | -0.158 | 17.8 |
| Male (athlete) | 0.637 | 0.205 | -0.180 | 12.5 |
| Female | 0.490 | 0.150 | -0.130 | 11.5 |
| Female (athlete) | 0.550 | 0.180 | -0.150 | 8.5 |

### Body fat fallback (Deurenberg)

When impedance is not available (e.g. the scale only measures weight), only **weight**, **BMI**, and **body fat** (estimated) are calculated. The remaining metrics (water, bone, muscle, visceral fat, physique rating) require impedance and will not be available.

Body fat without impedance is estimated from BMI:

```
Body Fat % = 1.2 * BMI + 0.23 * age - 10.8 * sex - 5.4
```

Where `sex` = 1 for male, 0 for female. For athletes, the result is multiplied by 0.85.

### Other metrics

| Metric | Formula |
|---|---|
| **BMI** | `weight / height_m²` |
| **Water** | `LBM * 0.73 / weight * 100` (athlete: 0.74) |
| **Bone Mass** | `LBM * 0.042` |
| **Muscle Mass** | `LBM * 0.54` (athlete: 0.60) |
| **Visceral Fat** | `Body Fat % * 0.55 - 4 + age * 0.08` |
| **BMR** | Mifflin-St Jeor: `10*W + 6.25*H - 5*A + s` where `s` = +5 male / -161 female |
| **Metabolic Age** | `age + (idealBMR - BMR) / 15` |

## Athlete Mode

Setting `is_athlete: true` in a user's profile adjusts the formulas for people who exercise regularly. The [setup wizard](/guide/configuration#setup-wizard-recommended) asks about this during user profile creation.

Effects:

- **Lean Body Mass** — different BIA coefficients (see table above)
- **Water** — higher hydration factor (74% vs 73% of LBM)
- **Muscle Mass** — higher factor (60% vs 54% of LBM)
- **BMR** — +5% boost
- **Metabolic Age** — capped at actual age minus 5
- **Deurenberg** — result multiplied by 0.85

## Scale-Provided Values

Some scales (Xiaomi Mi Scale 2, Yunmai) compute their own body composition on-device. When available, those values are used directly for fat, water, muscle, and bone. The remaining metrics (BMI, BMR, metabolic age, visceral fat, physique rating) are always calculated by BLE Scale Sync.

## References

- **BIA** — Lukaski H.C. et al. (1986), _"Assessment of fat-free mass using bioelectrical impedance measurements of the human body"_, American Journal of Clinical Nutrition
- **Mifflin-St Jeor** — Mifflin M.D., St Jeor S.T. et al. (1990), _"A new predictive equation for resting energy expenditure in healthy individuals"_, American Journal of Clinical Nutrition
- **Deurenberg** — Deurenberg P., Weststrate J.A., Seidell J.C. (1991), _"Body mass index as a measure of body fatness: age- and sex-specific prediction formulas"_, British Journal of Nutrition
