---
title: Supported Scales
description: All 23 BLE smart scale brands supported by BLE Scale Sync.
---

# Supported Scales

BLE Scale Sync supports **23 scale brands** out of the box. All scales provide weight + impedance for full [body composition](/body-composition) calculation.

## Scale List

| Brand / Model | Notes |
|---|---|
| **Xiaomi** Mi Scale 2 (MIBCS / MIBFS) | Uses scale's own body comp values |
| **Renpho** ES-CS20M / FITINDEX / Sencor (QN-Scale) | Most common generic BLE protocol |
| **Renpho** ES-WBE28 | Standard GATT variant |
| **Renpho** ES-26BB-B | |
| **1byone** / **Eufy** C1 / P1 | |
| **Yunmai** Signal / Mini / SE | Uses scale's own body comp values |
| **Beurer** BF700 / BF710 / BF800 | |
| **Sanitas** SBF70 / SBF75 | Same protocol as Beurer |
| **Sanitas** SBF72 / SBF73 / **Beurer** BF915 | Requires user slot 1 via manufacturer app |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100 | Requires user slot 1 via manufacturer app |
| **Medisana** BS430 / BS440 / BS444 | |
| **Active Era** BS-06 | |
| **Senssun** Fat | Model A only (0xFFF0) |
| **MGB** (Swan / Icomon / YG) | |
| **Digoo** DG-SO38H (Mengii) | |
| **Excelvan** CF369 | |
| **Trisa** Body Analyze | |
| **Hoffen** BS-8107 | |
| **Hesley** (YunChen) | |
| **Inlife** (FatScale) | |
| **Exingtech** Y1 (vscale) | |
| Any **standard BT SIG** scale (BCS/WSS) | Catch-all for standard-compliant scales |

::: info Sorted by popularity
Most widely available brands are listed first. The Standard BT SIG adapter at the bottom acts as a catch-all for any scale that follows the official Bluetooth Body Composition Service or Weight Scale Service specification.
:::

## Finding Your Scale

The [setup wizard](/guide/configuration#setup-wizard-recommended) includes interactive scale discovery — it scans for nearby BLE devices, identifies supported scales, and writes the config for you. To scan without the wizard:

```bash
# Docker
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  ghcr.io/kristianp26/ble-scale-sync:latest scan

# Native
npm run scan
```

::: tip Set your scale's MAC address
We recommend setting `scale_mac` in `config.yaml` — it prevents the app from accidentally connecting to a neighbor's scale. The setup wizard does this automatically. If you skip it, the app falls back to auto-discovery by BLE advertisement name.
:::

## Known Limitations

| Scale | What to do |
|---|---|
| **Soehnle**, **Sanitas** SBF72/73, **Beurer** BF915 | Create user slot 1 in the manufacturer's phone app first |
| **Standard GATT** | Select user 1 on the scale before measuring |
| **Senssun** Model B | Not supported yet (only Model A with service 0xFFF0) |
| **Renpho ES-CS20M** (some hardware variants) | Some units use broadcast-only firmware that does not allow GATT connections. The same model name can ship with different internal hardware. If your ES-CS20M is broadcast-only, ble-scale-sync reads weight directly from BLE advertisements. Body composition is estimated from BMI (Deurenberg formula) instead of impedance, since impedance is not available in broadcast mode. Run `npm run diagnose` to check whether your unit is connectable or broadcast-only. |

## Don't See Your Scale?

If your scale uses BLE but isn't listed, it might still work — the **Standard BT SIG** adapter catches any scale that follows the official Bluetooth specification. Run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `npm run scan` to check.

Want to add support for a new scale? See [Contributing](https://github.com/KristianP26/ble-scale-sync/blob/main/CONTRIBUTING.md#adding-a-new-scale-adapter).
