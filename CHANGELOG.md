# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.21.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.20.0...v1.21.0) (2026-07-20)


### Added

* **ble:** add weight-only Renpho R-MSC04 scale adapter ([#117](https://github.com/KristianP26/ble-scale-sync/issues/117), [#265](https://github.com/KristianP26/ble-scale-sync/issues/265)) ([f0dc658](https://github.com/KristianP26/ble-scale-sync/commit/f0dc658b2ced52550a98151caba94908b3e8ff07))


### Fixed

* **body-comp:** report muscle mass as fat-free mass minus bone ([#253](https://github.com/KristianP26/ble-scale-sync/issues/253)) ([7efa781](https://github.com/KristianP26/ble-scale-sync/commit/7efa7816fab080a0b629266dd1207d27842ee4bd))
* **runtime:** tick the healthcheck heartbeat on a timer so idle is not unhealthy ([#277](https://github.com/KristianP26/ble-scale-sync/issues/277)) ([2fca68f](https://github.com/KristianP26/ble-scale-sync/commit/2fca68feb0fe921adc6bbfa0681b092798009469))
* **scales:** claim OEM/rebranded Hutbit ("SWAN") via the 0x02AC manufacturer signature ([#279](https://github.com/KristianP26/ble-scale-sync/issues/279)) ([eb3b669](https://github.com/KristianP26/ble-scale-sync/commit/eb3b669759edb2ef110a306040fb238847131497))
* **scales:** gate Eufy P2 and 1byone completion on a settled weight ([#284](https://github.com/KristianP26/ble-scale-sync/issues/284)) ([#285](https://github.com/KristianP26/ble-scale-sync/issues/285)) ([7edfe6c](https://github.com/KristianP26/ble-scale-sync/commit/7edfe6c5ef463ff4d45678cabcb335fe81d514f9))
* **scales:** narrow the Hutbit OEM claim and pass mfg data on noble target-MAC ([#278](https://github.com/KristianP26/ble-scale-sync/issues/278)) ([9d17405](https://github.com/KristianP26/ble-scale-sync/commit/9d174056bc8c52c4fb92fa7527bcd1fe3b2898a1))
* **scales:** route Beurer BF788 and BF950 to the SIG consent adapter ([#229](https://github.com/KristianP26/ble-scale-sync/issues/229), [#255](https://github.com/KristianP26/ble-scale-sync/issues/255)) ([5cd3f92](https://github.com/KristianP26/ble-scale-sync/commit/5cd3f929e496d25fb7e0e14b28faa14f79e8a974))
* **scales:** stop the Beurer adapter hijacking its siblings, and honour lb frames ([c5362a2](https://github.com/KristianP26/ble-scale-sync/commit/c5362a2baefcafe8d5a659e947e3d0064e220c40))


### Docs

* document the shipped Renpho R-MSC04 adapter and its weight-only limitation ([#117](https://github.com/KristianP26/ble-scale-sync/issues/117)) ([8ece358](https://github.com/KristianP26/ble-scale-sync/commit/8ece358543352d1debfe06318ccd991bfe191f48))

## [1.20.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.19.0...v1.20.0) (2026-07-13)


### Added

* **scales:** add Hutbit Smart Scale adapter ([#268](https://github.com/KristianP26/ble-scale-sync/issues/268)) ([f20f7a8](https://github.com/KristianP26/ble-scale-sync/commit/f20f7a87a6edcdde99edab671b679b840e78eba8))
* **scales:** add Koogeek-S1 adapter ([#270](https://github.com/KristianP26/ble-scale-sync/issues/270)) ([50ae1d6](https://github.com/KristianP26/ble-scale-sync/commit/50ae1d6b5e0250a05c59dd88471ce0c5254da2d5))


### Fixed

* **addon:** run the Home Assistant add-on unconfined so it can reach BlueZ ([cac714b](https://github.com/KristianP26/ble-scale-sync/commit/cac714b6ea651b35b2d5f9e3b3af3922dd822cde)), closes [#271](https://github.com/KristianP26/ble-scale-sync/issues/271)
* **ble:** keep the ESPHome proxy connection alive on unknown API messages ([#252](https://github.com/KristianP26/ble-scale-sync/issues/252)) ([e561b91](https://github.com/KristianP26/ble-scale-sync/commit/e561b91aecaebc656c6552130eb9a45a2afc8260))
* **ble:** re-resolve adapter after GATT discovery on proxy paths ([#258](https://github.com/KristianP26/ble-scale-sync/issues/258), [#251](https://github.com/KristianP26/ble-scale-sync/issues/251), [#255](https://github.com/KristianP26/ble-scale-sync/issues/255)) ([9aca212](https://github.com/KristianP26/ble-scale-sync/commit/9aca21290f5df83ff5327c69affc881d5cd28e01))
* **ble:** wrap dynamic-path device.gatt() in withTimeout ([#273](https://github.com/KristianP26/ble-scale-sync/issues/273)) ([0531e35](https://github.com/KristianP26/ble-scale-sync/commit/0531e35a9011f72d05253c99111cbbd50719d479))
* **firmware:** enable BLE CCCD notifications in start_notify ([#274](https://github.com/KristianP26/ble-scale-sync/issues/274)) ([368353e](https://github.com/KristianP26/ble-scale-sync/commit/368353e846491e9527b041f891f7875de86b56be))
* **renpho:** only require the UCP char, guard the vendor 0xFFE2 writes ([#267](https://github.com/KristianP26/ble-scale-sync/issues/267)) ([f4d7d5c](https://github.com/KristianP26/ble-scale-sync/commit/f4d7d5cb055163df009c81cdc39feb7ef20644f1))
* **renpho:** perform SIG consent handshake so the ES-WBE28 streams readings ([#267](https://github.com/KristianP26/ble-scale-sync/issues/267)) ([65ed721](https://github.com/KristianP26/ble-scale-sync/commit/65ed7213f1108a867710a81072c794f743afb867))
* **scales:** complete Yunmai weight-only reading instead of timing out ([a86ffe8](https://github.com/KristianP26/ble-scale-sync/commit/a86ffe873dd4854121e7de7c61a3ddf26b35c4e5))
* **scales:** honour configured weight_unit in the QN display command ([#269](https://github.com/KristianP26/ble-scale-sync/issues/269)) ([d188970](https://github.com/KristianP26/ble-scale-sync/commit/d1889704be25b0505f0ef9bd335af736080a5cbf))
* **scales:** identify Type-1 QN scales by char pair over the ESP32 proxy ([#272](https://github.com/KristianP26/ble-scale-sync/issues/272)) ([76737ed](https://github.com/KristianP26/ble-scale-sync/commit/76737edbdb4c63d7afeed81c629dd40125a1949b))
* **scales:** route Beurer BF500 to the SIG consent adapter ([#83](https://github.com/KristianP26/ble-scale-sync/issues/83)) ([25bbc20](https://github.com/KristianP26/ble-scale-sync/commit/25bbc200271d1b505245e3cb214468ca5d0fb43c))
* **scales:** write the Hutbit FFB1 handshake without response ([#268](https://github.com/KristianP26/ble-scale-sync/issues/268)) ([de12300](https://github.com/KristianP26/ble-scale-sync/commit/de123007abdc97ebd667fec26916344e471652ae))

## [1.19.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.18.0...v1.19.0) (2026-06-19)


### Added

* **config:** add ble.bind_key and adapter configure() hook ([#232](https://github.com/KristianP26/ble-scale-sync/issues/232)) ([b319e69](https://github.com/KristianP26/ble-scale-sync/commit/b319e69f7ea085472bfcb5ba6218b21b37aaede1))
* **scales:** add declarative MatchDescriptor and matchesDescriptor helper ([#245](https://github.com/KristianP26/ble-scale-sync/issues/245)) ([7e63799](https://github.com/KristianP26/ble-scale-sync/commit/7e637998ba8c68002fad9f9bb331f9340263305e))
* **scales:** add Xiaomi Mijia S800 broadcast adapter ([#232](https://github.com/KristianP26/ble-scale-sync/issues/232)) ([5ee2c2e](https://github.com/KristianP26/ble-scale-sync/commit/5ee2c2eb4edf600eba414e91585743b103db641c))
* **scales:** central resolveAdapter with priority-based precedence and startup overlap detection ([#245](https://github.com/KristianP26/ble-scale-sync/issues/245)) ([dcc2bdd](https://github.com/KristianP26/ble-scale-sync/commit/dcc2bddafa31f5320729538b1d59a1ac08fad2ba))
* **scales:** register Xiaomi S800 and inject bind key at startup ([#232](https://github.com/KristianP26/ble-scale-sync/issues/232)) ([d3fdb65](https://github.com/KristianP26/ble-scale-sync/commit/d3fdb655fdf9d89f96f3e2770d15b0aa9c7db685))


### Fixed

* **ble:** advertise lazy_notify capability to ESP32 proxy ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([9004d31](https://github.com/KristianP26/ble-scale-sync/commit/9004d316b60b70c3cc7e76f673a4dbada609fa96))
* **ble:** command host-ordered proxy notify enable after subscribe ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([d33e3aa](https://github.com/KristianP26/ble-scale-sync/commit/d33e3aa60214dad1326c706bdb9cbde97c09fa61))
* **ble:** correct Robi S9 weight scaling to 3-byte grams ([#248](https://github.com/KristianP26/ble-scale-sync/issues/248)) ([21b3afa](https://github.com/KristianP26/ble-scale-sync/commit/21b3afa5a707815ddceb3f8a750f65f2eea69ee9))
* **firmware:** add per-board IDF-heap guard tunables defaulting to 0 ([#139](https://github.com/KristianP26/ble-scale-sync/issues/139)) ([59bd65f](https://github.com/KristianP26/ble-scale-sync/commit/59bd65f8a7b83851c1acecd75c8d91054409b992))
* **firmware:** drain aioble services before characteristic discovery ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([c584098](https://github.com/KristianP26/ble-scale-sync/commit/c58409824672a9ab163d523a9bcbe3d7e9a36498))
* **firmware:** drive aioble GATT discovery with async for ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([c943e11](https://github.com/KristianP26/ble-scale-sync/commit/c943e11b87213300619872656b5af91ea3579970))
* **firmware:** enable proxy notify lazily on per-char subscribe command ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([f4a4492](https://github.com/KristianP26/ble-scale-sync/commit/f4a4492606bd798d3813d698806d5c46f8cb073f))
* **firmware:** parse lazy_notify capability flag from config ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([b24292a](https://github.com/KristianP26/ble-scale-sync/commit/b24292a447bd851f92c7db9508047b3050a05841))
* **firmware:** refuse GATT connect on near-empty IDF heap instead of crashing ([#139](https://github.com/KristianP26/ble-scale-sync/issues/139)) ([1beac82](https://github.com/KristianP26/ble-scale-sync/commit/1beac82c6fdf57279855a7f06972f83a05502ac2))
* **firmware:** retry opposite BLE address type on any connect failure ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([7a958ab](https://github.com/KristianP26/ble-scale-sync/commit/7a958ab0f4ca83364014617281bed1f21a259d64))
* **firmware:** trust controller-reported BLE address type on autonomous connect ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([4ae2662](https://github.com/KristianP26/ble-scale-sync/commit/4ae2662fd96e8b29d13226c1909a97222254f758))
* **scales:** preserve exact/startsWith claim semantics in generic-adapter exclusion ([#245](https://github.com/KristianP26/ble-scale-sync/issues/245)) ([99a5a10](https://github.com/KristianP26/ble-scale-sync/commit/99a5a1085f13c91bba3661a8a88e2c0fe459103b))


### Docs

* align scale-type vs board support table cells for [#139](https://github.com/KristianP26/ble-scale-sync/issues/139) ([e301da7](https://github.com/KristianP26/ble-scale-sync/commit/e301da7839398fd8868e48bb23704aae0df96831))
* document no-PSRAM broadcast-only vs PSRAM GATT support for [#139](https://github.com/KristianP26/ble-scale-sync/issues/139) ([fa63930](https://github.com/KristianP26/ble-scale-sync/commit/fa6393045e168020b7dc19932f96a7cc8da311bb))
* document Xiaomi S800 support and ble.bind_key ([#232](https://github.com/KristianP26/ble-scale-sync/issues/232)) ([6ccccb0](https://github.com/KristianP26/ble-scale-sync/commit/6ccccb09e937db62ac09f58aebea9b38c98f3ae9))
* **firmware:** correct gc-vs-IDF-heap comment around the connect guard ([#139](https://github.com/KristianP26/ble-scale-sync/issues/139)) ([e576e8e](https://github.com/KristianP26/ble-scale-sync/commit/e576e8e4d36baac608c1dd9419e099dfa4c79242))
* fix stale counts, logo easter egg, and consolidate changelog menu ([cf85243](https://github.com/KristianP26/ble-scale-sync/commit/cf852434b591a49370f8d711008dcd7920946735))
* unify historical changelog entries to release-please format ([6d29c7e](https://github.com/KristianP26/ble-scale-sync/commit/6d29c7e839827685cefd6072c1a172523a64d4a5))

## [1.18.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.17.0...v1.18.0) (2026-06-16)


### Added

* **exporter:** add Runalyze exporter ([#204](https://github.com/KristianP26/ble-scale-sync/issues/204)) ([8f8d7a0](https://github.com/KristianP26/ble-scale-sync/commit/8f8d7a0222bfb883fedf9c989764aed585769712))
* **exporter:** add Wger exporter ([#205](https://github.com/KristianP26/ble-scale-sync/issues/205)) ([a9aed3a](https://github.com/KristianP26/ble-scale-sync/commit/a9aed3a7d57db9a8a93ebf6c6bc1bc8d710085d3))


### Fixed

* **ble:** bootstrap ESP32 autonomous GATT connect for GATT-only scales ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([2266086](https://github.com/KristianP26/ble-scale-sync/commit/226608682f973e444b3741cae4af92a9c98d5427))
* **ble:** connect before publishing scan results on autonomous path ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([793fdb2](https://github.com/KristianP26/ble-scale-sync/commit/793fdb2025d8da47500b2eaa5a102c34811c0d2e))
* **ble:** connect random-address GATT scales via ESP32 proxy ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([989ace6](https://github.com/KristianP26/ble-scale-sync/commit/989ace6a529d8252a149016349bad231fe07f940))
* **ble:** correct misreported static-random addr_type at scan source ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([0a2097e](https://github.com/KristianP26/ble-scale-sync/commit/0a2097e8973445a6201599b41d5a7f872dfeb34e))
* **ble:** derive connect addr_type from MAC bits for misreported random scales ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([4909038](https://github.com/KristianP26/ble-scale-sync/commit/4909038b2a4f2052d0fba85e7fc10131e4fad938))
* **ble:** preserve bond by not RemoveDevice'ing paired scales ([#168](https://github.com/KristianP26/ble-scale-sync/issues/168)) ([d662199](https://github.com/KristianP26/ble-scale-sync/commit/d662199e45a14c6bfaf45018682177bbe618e6a1))
* **ble:** register BlueZ pairing agent for BF720 encrypted bonding ([#168](https://github.com/KristianP26/ble-scale-sync/issues/168)) ([d2a1aaf](https://github.com/KristianP26/ble-scale-sync/commit/d2a1aafa650c4e02dc5da89db7c99d15a0f0e012))
* **esp32:** restore aioble IRQ before GATT connect ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([c29dc1c](https://github.com/KristianP26/ble-scale-sync/commit/c29dc1c41439b35207b16759481aa81ffd6c5d9e))


### Changed

* **ble:** single pre-connect GC pass on PSRAM boards ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([62e134b](https://github.com/KristianP26/ble-scale-sync/commit/62e134b1f4859a613bfb99f002d60bbc5316edb6))


### Docs

* note minimal-delay autonomous connect for GATT scales ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([b679550](https://github.com/KristianP26/ble-scale-sync/commit/b6795504c6dc562c18c2551629fbbe38cd381c61))
* recommend scale_mac for GATT-only scales over the ESP32 proxy ([#231](https://github.com/KristianP26/ble-scale-sync/issues/231)) ([8b670c1](https://github.com/KristianP26/ble-scale-sync/commit/8b670c1e1042d1b8d76fcb9c65d8eb3743cc49f7))

## [1.17.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.16.1...v1.17.0) (2026-06-15)


### Added

* **ble:** add Robi S9 adapter (Lefu/Fitdays FFB0-new protocol) ([#228](https://github.com/KristianP26/ble-scale-sync/issues/228)) ([4a8fda5](https://github.com/KristianP26/ble-scale-sync/commit/4a8fda56fa57bbb4f97b2a7cb36ca475a70e5515))


### Fixed

* **ble:** attempt bonding and name failed CCCD subscribe for Beurer BF720 ([#168](https://github.com/KristianP26/ble-scale-sync/issues/168)) ([45bfd87](https://github.com/KristianP26/ble-scale-sync/commit/45bfd87cf51de6ec565d6fdcd7038f5da197d31e))
* **ble:** match QN scales advertising AE00 alongside fff0 ([#235](https://github.com/KristianP26/ble-scale-sync/issues/235)) ([6a12687](https://github.com/KristianP26/ble-scale-sync/commit/6a126877120b106ff1a9d452e46eb146477c3160))
* **firmware:** ease GATT connect on no-PSRAM ESP32 + heap diagnostic ([#139](https://github.com/KristianP26/ble-scale-sync/issues/139)) ([7bef0f6](https://github.com/KristianP26/ble-scale-sync/commit/7bef0f6866a3e1700eff607d1adbe18dea0cf00e))

## [1.16.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.16.0...v1.16.1) (2026-06-15)


### Fixed

* **ble:** decode Sanitas SBF70/BF710 body composition via 0x59 ACK stream ([#211](https://github.com/KristianP26/ble-scale-sync/issues/211)) ([c3beb00](https://github.com/KristianP26/ble-scale-sync/commit/c3beb007372ff0a051a82d1ba411b6ef14d9e7ab))
* **ble:** parse QN 0x23 stored record for V10 Renpho/ES-CS20M ([#213](https://github.com/KristianP26/ble-scale-sync/issues/213)) ([5617f28](https://github.com/KristianP26/ble-scale-sync/commit/5617f28fb7d02f47a34c86a2aa7b29fbdbe33688))
* **ble:** read ESPHome proxy pre-decoded GATT uuid ([#229](https://github.com/KristianP26/ble-scale-sync/issues/229)) ([#234](https://github.com/KristianP26/ble-scale-sync/issues/234)) ([c1079c7](https://github.com/KristianP26/ble-scale-sync/commit/c1079c72375856b8179234bebd5d5e1ef82a7f60))

## [1.16.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.15.0...v1.16.0) (2026-06-04)


### Added

* **ble:** add adapter liveness probe for watchdog classification ([#213](https://github.com/KristianP26/ble-scale-sync/issues/213)) ([e50ce5b](https://github.com/KristianP26/ble-scale-sync/commit/e50ce5b0128ab488f06ec3895306cdc4e557bfbe))
* **ble:** add poll-failure classification helpers ([#213](https://github.com/KristianP26/ble-scale-sync/issues/213)) ([484e16a](https://github.com/KristianP26/ble-scale-sync/commit/484e16ac32d58bd24dd78fe6d190afd97bd5dd04))
* **mqtt-proxy:** ESP32 autonomous GATT connect for fast-sleeping scales ([#214](https://github.com/KristianP26/ble-scale-sync/issues/214)) ([c4a3b33](https://github.com/KristianP26/ble-scale-sync/commit/c4a3b33ce28a003e63dfbdf14ae10991d6df9ff1))


### Fixed

* **ble:** keep a permanent error listener on the ESPHome proxy client ([#210](https://github.com/KristianP26/ble-scale-sync/issues/210)) ([ca7eb7d](https://github.com/KristianP26/ble-scale-sync/commit/ca7eb7d2f048a6f90d65d75878340ba7b0544525))
* **ble:** reset gattInProgress on failed GATT connect + clearer ESP32 errors ([#201](https://github.com/KristianP26/ble-scale-sync/issues/201)) ([dcd1ac6](https://github.com/KristianP26/ble-scale-sync/commit/dcd1ac6f7d1a456b1e83eecf57a3709bddb2dd5f))
* **ble:** send BLE address type on ESPHome proxy GATT connect ([#215](https://github.com/KristianP26/ble-scale-sync/issues/215)) ([#223](https://github.com/KristianP26/ble-scale-sync/issues/223)) ([71e735b](https://github.com/KristianP26/ble-scale-sync/commit/71e735b6c3460f9aa2b3d2d9e724c06da94ddeae))
* **ble:** tag idle vs wedge poll failures in scanAndReadRaw ([#213](https://github.com/KristianP26/ble-scale-sync/issues/213)) ([407753e](https://github.com/KristianP26/ble-scale-sync/commit/407753e261815f31e128a88b5f97da7352baabda))
* **config:** accept bare 32-hex CoreBluetooth UUID for scale_mac ([#212](https://github.com/KristianP26/ble-scale-sync/issues/212)) ([#224](https://github.com/KristianP26/ble-scale-sync/issues/224)) ([47d5033](https://github.com/KristianP26/ble-scale-sync/commit/47d503329a828c5127c827df98e902dc26cee36c))
* **firmware:** flush scan batch early on a known scale MAC ([#201](https://github.com/KristianP26/ble-scale-sync/issues/201)) ([c692b42](https://github.com/KristianP26/ble-scale-sync/commit/c692b426972edaf0fb895475262afa166cf72587))
* **runtime:** watchdog ignores idle no-shows ([#213](https://github.com/KristianP26/ble-scale-sync/issues/213)) ([9e1588f](https://github.com/KristianP26/ble-scale-sync/commit/9e1588faf84ac352ec3f9e41029d8406007e060c))


### Docs

* note idle-aware watchdog behavior ([#213](https://github.com/KristianP26/ble-scale-sync/issues/213)) ([7de309e](https://github.com/KristianP26/ble-scale-sync/commit/7de309ed6a33fab0150a2101909bcaa65544af6f))

## [1.15.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.14.1...v1.15.0) (2026-05-21)


### Added

* **exporter:** add Intervals.icu exporter ([#203](https://github.com/KristianP26/ble-scale-sync/issues/203)) ([60af3d0](https://github.com/KristianP26/ble-scale-sync/commit/60af3d0e98fdb90268dbe43d7316b6bc8e9ff3c1))
* **exporter:** add Telegram exporter ([#207](https://github.com/KristianP26/ble-scale-sync/issues/207)) ([0b73e0f](https://github.com/KristianP26/ble-scale-sync/commit/0b73e0f76601603e578f824d5b92cccf2c451e29))
* **firmware:** support generic ESP-WROOM-32 boards ([487e482](https://github.com/KristianP26/ble-scale-sync/commit/487e482084ac42be73f8f6f4bde9d356f2f6a1a1))


### Fixed

* **ble:** route dual-mode adapters to GATT when no broadcast data ([#201](https://github.com/KristianP26/ble-scale-sync/issues/201)) ([9de2dee](https://github.com/KristianP26/ble-scale-sync/commit/9de2deea0f8223f72a1c631ed31584a5600a6fba))
* **exporters:** fail fast on non-retryable HTTP errors + validate required config ([6ebea77](https://github.com/KristianP26/ble-scale-sync/commit/6ebea77b81320eeb7bf20a106c96b1cb460c524a))
* **firmware:** harden constrained ESP32 boards against scan-buffer OOM ([c99605e](https://github.com/KristianP26/ble-scale-sync/commit/c99605e22f667f06023fdd9ee3f57c4f0c8b9e36))
* **firmware:** parse 128-bit / 32-bit service UUIDs and service data ([bf918ad](https://github.com/KristianP26/ble-scale-sync/commit/bf918ad75fbaeb35465544af74871a5f0bd286fb))
* **firmware:** publish service-UUID-only devices in scan results ([c1f9723](https://github.com/KristianP26/ble-scale-sync/commit/c1f9723013972749846acb7ff76fa5ec169a164c)), closes [#201](https://github.com/KristianP26/ble-scale-sync/issues/201)


### Docs

* bump adapter and exporter counts to 25 and 8 ([0e21abe](https://github.com/KristianP26/ble-scale-sync/commit/0e21abe88f5073238d2e3bdc7da840a505270304))
* **scales:** note Mi Scale 2 works on all BLE transports ([e126848](https://github.com/KristianP26/ble-scale-sync/commit/e126848ad11a976c6956dbff5ee67ce755553306))

## [1.14.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.14.0...v1.14.1) (2026-05-19)


### Fixed

* **firmware:** correct mip ref position for async primitives install ([8974caa](https://github.com/KristianP26/ble-scale-sync/commit/8974caa1f9b55cabb792fb0532b29785518feabb)), closes [#198](https://github.com/KristianP26/ble-scale-sync/issues/198)
* force-exit on hung shutdown so the watchdog actually restarts the container ([#194](https://github.com/KristianP26/ble-scale-sync/issues/194)) ([#196](https://github.com/KristianP26/ble-scale-sync/issues/196)) ([3b60393](https://github.com/KristianP26/ble-scale-sync/commit/3b6039397f53bc4d85f94a9889b7fedac4b24356))

## [1.14.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.13.1...v1.14.0) (2026-05-18)


### Added

* **ble:** registry self-check to prevent adapter matches() collisions ([#182](https://github.com/KristianP26/ble-scale-sync/issues/182)) ([663f55a](https://github.com/KristianP26/ble-scale-sync/commit/663f55a8a9736967626312ca6d4f561a6db62295))
* **ble:** ESPHome proxy Phase 2 - GATT + multi-proxy ([#116](https://github.com/KristianP26/ble-scale-sync/issues/116)) ([#187](https://github.com/KristianP26/ble-scale-sync/issues/187)) ([c850aa3](https://github.com/KristianP26/ble-scale-sync/commit/c850aa3b55b018143cb99e4659b53f04f1720ae2))
* **scales:** Beurer BF720 / BF105 SIG-standard adapter ([#168](https://github.com/KristianP26/ble-scale-sync/issues/168)) ([#180](https://github.com/KristianP26/ble-scale-sync/issues/180)) ([3f52568](https://github.com/KristianP26/ble-scale-sync/commit/3f525688a099d5e5510edfb96e60cec9ab91fe3e))
* **scales:** add Eufy T9120 (A1) support ([#178](https://github.com/KristianP26/ble-scale-sync/issues/178)) ([3f5ecd4](https://github.com/KristianP26/ble-scale-sync/commit/3f5ecd44e6f511b86e343f4dd392a9d031960ba1))


### Fixed

* **scales:** defer Renpho ES-WBE28 from the QN adapter ([#191](https://github.com/KristianP26/ble-scale-sync/issues/191)) ([27a58d5](https://github.com/KristianP26/ble-scale-sync/commit/27a58d5dda2e10ff6aced5df296637efa890c851))
* **ble:** characteristic-aware adapter matching for 0xFFF0 collision ([#177](https://github.com/KristianP26/ble-scale-sync/issues/177)) ([#179](https://github.com/KristianP26/ble-scale-sync/issues/179)) ([6cb7992](https://github.com/KristianP26/ble-scale-sync/commit/6cb799290687fd02c84dbcbfb7dd1fc5106eddcb))


### Docs

* add boildead and alexw23 to contributors ([bf15b87](https://github.com/KristianP26/ble-scale-sync/commit/bf15b8766da1670600dc71d246d04d7587001226))

## [1.13.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.13.0...v1.13.1) (2026-05-18)


### Fixed

* **docker:** add missing setup-strava command to entrypoint ([#188](https://github.com/KristianP26/ble-scale-sync/issues/188)) ([#189](https://github.com/KristianP26/ble-scale-sync/issues/189)) ([af47e3a](https://github.com/KristianP26/ble-scale-sync/commit/af47e3aa1322fa34a440f8d43781793802a46080))

## [1.13.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.12.1...v1.13.0) (2026-05-13)


### Added

* drop Node 20 support, require Node 22+ ([25712d1](https://github.com/KristianP26/ble-scale-sync/commit/25712d1b84274fbab95f0adbef3c76bcf423f3d8))
* replay cached offline frames with timestamps ([#164](https://github.com/KristianP26/ble-scale-sync/issues/164)) ([6bae585](https://github.com/KristianP26/ble-scale-sync/commit/6bae5858a8d63f373361ed1aef979915a23c1183))
* **scale:** support Renpho ES-32MD via ES-CS20M adapter ([#172](https://github.com/KristianP26/ble-scale-sync/issues/172)) ([068c14f](https://github.com/KristianP26/ble-scale-sync/commit/068c14f4563a6529afb6b5bbc7bfaa716371642f))


### Fixed

* **deps:** regen package-lock.json with emnapi entries (CI fix) ([40b3d9d](https://github.com/KristianP26/ble-scale-sync/commit/40b3d9dd5e77aeafc45818363a52db3bb50ab15a))
* **runtime:** use raw weight for single-user mqtt display ([b8d0b90](https://github.com/KristianP26/ble-scale-sync/commit/b8d0b909874f44385d2d2b595481d7a3f8e3f306))

## [1.12.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.12.0...v1.12.1) (2026-05-12)


### Fixed

* **ble:** RSSI freshness no longer treats absent prop as stale ([#167](https://github.com/KristianP26/ble-scale-sync/issues/167)) ([8340caa](https://github.com/KristianP26/ble-scale-sync/commit/8340caa0ef3de7a5499dfca26190cc5864ab8e7e)), closes [#169](https://github.com/KristianP26/ble-scale-sync/issues/169)

## [1.12.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.11.0...v1.12.0) (2026-05-06)


### Added

* **config:** hot-reload config.yaml without restart ([#123](https://github.com/KristianP26/ble-scale-sync/issues/123)) ([d213d5c](https://github.com/KristianP26/ble-scale-sync/commit/d213d5ccd242312f5251c59128708ca503b0cb23))
* **runtime:** systemd Type=notify watchdog integration ([#144](https://github.com/KristianP26/ble-scale-sync/issues/144)) ([68ee5bf](https://github.com/KristianP26/ble-scale-sync/commit/68ee5bf4b1aede87080c432512233f4e09b5a680))
* **scales:** add Xiaomi Mi Scale 2 broadcast adapter ([#134](https://github.com/KristianP26/ble-scale-sync/issues/134)) ([6e5ffb4](https://github.com/KristianP26/ble-scale-sync/commit/6e5ffb4fa994546231d42b6493cd875e2f2e46fe))
* **scales:** scaffold experimental ADE A2 adapter ([#159](https://github.com/KristianP26/ble-scale-sync/issues/159)) ([#160](https://github.com/KristianP26/ble-scale-sync/issues/160)) ([11aec6f](https://github.com/KristianP26/ble-scale-sync/commit/11aec6f79bc01c4c4a7dee9e68ffa2e0c72b2d51))
* **trisa:** implement ADE BA 1600 challenge response ([#138](https://github.com/KristianP26/ble-scale-sync/issues/138)) ([#158](https://github.com/KristianP26/ble-scale-sync/issues/158)) ([91aa28e](https://github.com/KristianP26/ble-scale-sync/commit/91aa28eedef68e0c77da7ceb389fe411b151f48c))


### Fixed

* **ble:** guard against dying-peer connect stall ([#143](https://github.com/KristianP26/ble-scale-sync/issues/143)) ([abd3c22](https://github.com/KristianP26/ble-scale-sync/commit/abd3c227547c4a92f05f2d5be47087049339b7c3))
* **ble:** per-address grace state in esphome-proxy scanAndReadRaw ([#161](https://github.com/KristianP26/ble-scale-sync/issues/161)) ([875cb28](https://github.com/KristianP26/ble-scale-sync/commit/875cb283c9df725e615f76e1c9919185ad773cc0))
* **review:** address v1.12.0 review findings ([ed90fbf](https://github.com/KristianP26/ble-scale-sync/commit/ed90fbf4d7fc3bbc1bdd94bc241942ef10df7c10))
* **runtime:** cache systemd-notify ENOENT to avoid spawn-storm on hosts without it ([#144](https://github.com/KristianP26/ble-scale-sync/issues/144)) ([8959287](https://github.com/KristianP26/ble-scale-sync/commit/895928768b78e84cd70c79a9bc7e26ff285a308d))
* **scales:** ack offline frames on Renpho ES-26BB-B ([#157](https://github.com/KristianP26/ble-scale-sync/issues/157)) ([70f2066](https://github.com/KristianP26/ble-scale-sync/commit/70f20669e178d99a2aa6783ed1f65b3c8fed1997))
* **scales:** warn instead of debug when ES-26BB-B offline ack write fails ([4e265e1](https://github.com/KristianP26/ble-scale-sync/commit/4e265e16bf20c5bedaff52c636f0fe71128982bf))


### Docs

* deep consistency sweep across guide and reference pages ([e979b0c](https://github.com/KristianP26/ble-scale-sync/commit/e979b0cf5b12d75f6d74e3152db9628a824297b8))
* **readme:** bump scale count, note Linux stability features ([5a47c06](https://github.com/KristianP26/ble-scale-sync/commit/5a47c064911a36b46f909e3e8bd55b7ad1a1fdab))

## [1.11.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.10.2...v1.11.0) (2026-05-01)


### Added

* **ble:** consecutive-failure watchdog for BlueZ stuck-state recovery ([#154](https://github.com/KristianP26/ble-scale-sync/pull/154)) ([dcc822d](https://github.com/KristianP26/ble-scale-sync/commit/dcc822d16bbebe7682490114febc92326b69a611))
* **trisa:** support ADE BA 1600 (fitvigo) firmware variant — weight only ([#153](https://github.com/KristianP26/ble-scale-sync/pull/153)) ([515d1a7](https://github.com/KristianP26/ble-scale-sync/commit/515d1a72faab28abbadddc41ddca60337358b68b))


### Fixed

* **firmware:** match scan_duration_ms to GATT connect timeout ([#141](https://github.com/KristianP26/ble-scale-sync/issues/141)) ([54dcc3b](https://github.com/KristianP26/ble-scale-sync/commit/54dcc3bda965ac9482659017f3c08d68efea716d))
* **node-ble:** add timeout to device.gatt() and waitForRawReading ([#142](https://github.com/KristianP26/ble-scale-sync/pull/142)) ([2e45366](https://github.com/KristianP26/ble-scale-sync/commit/2e45366623f873aaf1b415c3f1ccc4edef860613)), closes [#140](https://github.com/KristianP26/ble-scale-sync/issues/140)
* prevent orphaned BlueZ discovery sessions in continuous mode ([#81](https://github.com/KristianP26/ble-scale-sync/pull/81)) ([e6ee513](https://github.com/KristianP26/ble-scale-sync/commit/e6ee51350ced0ef9a50d77380d201a21627fcc76))
* **trisa:** fail fast when no measurement char and harden ADE parser boundary ([74a34a6](https://github.com/KristianP26/ble-scale-sync/commit/74a34a6e14d6b525114ed78372c43e07a0de6cd3))


### Docs

* **addon:** backfill CHANGELOG and refresh DOCS for v1.8.2 through v1.10.2 ([d918a1d](https://github.com/KristianP26/ble-scale-sync/commit/d918a1d677dad982dc123133352ae58539b93fb1))
* document Pi 3/4 BlueZ stuck-state limitation + watchdog mitigation ([a039b4b](https://github.com/KristianP26/ble-scale-sync/commit/a039b4b155b5677001994a1f6a3bbfc723b2b876))
* **esp32-proxy:** add Windows flashing guidance ([#152](https://github.com/KristianP26/ble-scale-sync/pull/152)) ([2796d7b](https://github.com/KristianP26/ble-scale-sync/commit/2796d7b0bcbced0bc1e5bca026fc275b6e02be21))
* **trisa:** clarify optional-binding + variant-detection semantics ([ae87d84](https://github.com/KristianP26/ble-scale-sync/commit/ae87d8421a446dd3b56cec63ab3baad476d87a0a))


### Thanks

* [@fromport](https://github.com/fromport) for the `device.gatt()` / `waitForRawReading` GATT-acquisition timeout fix that prevents indefinite hangs on stalled BlueZ adapters ([#142](https://github.com/KristianP26/ble-scale-sync/pull/142))

## [1.10.2](https://github.com/KristianP26/ble-scale-sync/compare/v1.10.1...v1.10.2) (2026-04-24)


### Fixed

* **Renpho ES-26M**: the 18-byte `0x12` scale-info frame (where byte[1] is the packet length and bytes [2-7] carry the device MAC) was being misread as "byte[2] is the protocol type", yielding `proto=0xFF` and causing every subsequent handshake command to be rejected by the scale. No `0x10` weight frames were ever returned. The QN-Scale adapter now detects the long-frame format (`data.length >= 18 && data[1] === length`) and falls through to the ES-30M code path with `weightScaleFactor=10`, so the existing heuristic auto-corrects the weight divisor. The unconditional skip of `R1=R2=0` stable frames in ES-30M mode is also lifted: the ES-26M never reports impedance when the user is wearing socks, and those frames are the only stable reading available in that scenario. Contributed by [@fromport](https://github.com/fromport) ([#128](https://github.com/KristianP26/ble-scale-sync/pull/128))


### Changed

* **ESPHome proxy**: the handler now logs a one-time Phase 1 capability summary on connect, listing which configured scale adapters are broadcast-capable (produce readings on this transport) and which are GATT-only (will time out until Phase 2 / [#116](https://github.com/KristianP26/ble-scale-sync/issues/116) ships). Users who were only seeing the generic `Timed out waiting for any recognized scale broadcast via ESPHome proxy` line now immediately see whether their scale brand is in the broadcast-capable set, instead of having to reproduce the failure twice to catch the per-MAC warn. Surfaces the Yunmai / Beurer / Mi Scale 2 / etc. mismatch reported by [@geniusliang](https://github.com/geniusliang) in [#133](https://github.com/KristianP26/ble-scale-sync/issues/133)


### Docs

* **CONTRIBUTING.md**: project structure tree refreshed to match the current layout (HA add-on, ESPHome proxy handler, updated scale/test files)
* **README**: contributors migrated to a GitHub-style table with inline avatars, [@fromport](https://github.com/fromport) added for the ES-26M contribution


### Thanks

* [@fromport](https://github.com/fromport) for diagnosing and fixing the ES-26M handshake end to end, including the heuristic weight-divisor path
* [@geniusliang](https://github.com/geniusliang) for the detailed ESPHome proxy repro that led to the capability-summary UX improvement

## [1.10.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.10.0...v1.10.1) (2026-04-22)


### Fixed

* **ESPHome proxy**: the `ReadingWatcher` silently dropped advertisements from dual-mode scale adapters (`parseBroadcast` defined **and** `charNotifyUuid` set) when the broadcast frame was not weight-bearing. Reported by [@deadhurricane](https://github.com/deadhurricane) on an Elis 1 / ES-30M, which matches by name as a QN-Scale but only beacons its MAC in manufacturer data and carries weight over GATT. The handler now warns once per MAC that the scale needs a GATT connection (Phase 2), pointing the user at the native BLE handler or the ESP32 MQTT proxy as workarounds instead of leaving them staring at a silent log ([#116](https://github.com/KristianP26/ble-scale-sync/issues/116), [#75](https://github.com/KristianP26/ble-scale-sync/issues/75))
* **Logger**: `runtime.debug: true` in `config.yaml` did not switch the log level to DEBUG, only the `DEBUG=true` env var did. The app now honors the config value on startup, so HA Add-on users (who pass `debug` as an option, not an env var) and anyone driving the runtime from `config.yaml` get the verbose BLE logs they expect

## [1.10.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.9.0...v1.10.0) (2026-04-22)


### Added

* **Embedded MQTT broker for the ESP32 proxy**: zero-config setup, no Mosquitto required. When `ble.mqtt_proxy.broker_url` is omitted, BLE Scale Sync now starts an embedded [aedes](https://github.com/moscajs/aedes) broker on `0.0.0.0:1883` by default; the internal client connects over loopback, and the ESP32 firmware just points at the host machine's LAN IP. Port and bind interface are configurable via `embedded_broker_port` and `embedded_broker_bind`, optional username/password are enforced when set. Existing `broker_url` setups are untouched ([#54](https://github.com/KristianP26/ble-scale-sync/issues/54))
* **ESPHome Bluetooth proxy transport (experimental, phase 1 / broadcast-only)**: third BLE handler option `ble.handler: esphome-proxy`. If you already run an [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy.html) mesh for Home Assistant, BLE Scale Sync can connect to it over Native API (port 6053, optional Noise encryption or legacy password) and reuse it as its BLE radio, so no dedicated ESP32 with custom firmware and no MQTT broker are required. Phase 1 handles broadcast scales only; GATT scales log a warning and are skipped until phase 2 lands. New `docs/guide/esphome-proxy.md` covers setup, encryption key handling and limitations ([#116](https://github.com/KristianP26/ble-scale-sync/issues/116))
* **Setup wizard**: new "Use built-in embedded broker" option for the mqtt-proxy handler, so new installs skip the external broker prompt by default. Handler selection now also includes "Via ESPHome Bluetooth proxy" with prompts for host, port and authentication mode


### Security

* **Embedded MQTT broker**: configs that bind the embedded broker to a non-loopback interface (default `0.0.0.0`) now require `username` + `password` and are rejected at schema validation time. The wizard defaults to requiring auth and falls back to `127.0.0.1` when the user declines, so misconfiguration cannot silently expose a LAN-reachable broker without credentials.
* **ESPHome proxy**: configs that set both `encryption_key` and `password` are rejected at schema validation time. Pick Noise (`encryption_key`, recommended) or legacy password, not both.

## [1.9.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.8.2...v1.9.0) (2026-04-21)


### Added

* **Eufy Smart Scale P2 (T9148) and P2 Pro (T9149)**: new dedicated adapter with the AES-128-CBC C0/C1/C2/C3 handshake required by these models. Weight + impedance over GATT FFF2 after authentication, passive weight reading from the 19-byte advertisement without connecting. Prevents the prior false match as a QN scale that crashed with `Operation is not supported` on FFF1 ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))


### Fixed

* **Setup wizard**: picking no exporter in the export-targets checkbox silently produced a config without any `global_exporters` block, so the first run emitted `All exports failed` and exited with code 1. The wizard now asks an explicit `Continue without exporters?` confirmation when the checkbox is submitted empty and re-prompts if the user declines ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))
* **Orchestrator**: `dispatchExports([])` logged `All exports failed` because `allFailed` defaulted to `true` with zero iterations. Empty exporter lists now short-circuit with a clear warning (`No exporters configured — measurement processed but not sent anywhere`) and return `success`, so single-shot mode no longer exits with code 1 when the config has no exporters


### Thanks

* [@mart1058](https://github.com/mart1058) and [@dbrb2](https://github.com/dbrb2) for diagnose output, HCI snoop logs, and testing the Eufy P2 Pro protocol reverse-engineering ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))
* [bdr99/eufylife-ble-client](https://github.com/bdr99/eufylife-ble-client) for the reference Python implementation of the Eufy T9148/T9149 auth handshake and frame formats

## [1.8.2](https://github.com/KristianP26/ble-scale-sync/compare/v1.8.1...v1.8.2) (2026-04-20)


### Fixed

* **Sanitas SBF70 / Beurer BF710 family**: weight parsed as a stuck `12.80 kg` regardless of the real reading on the scale. Root cause: the BF710 variant (start byte `0xE7`) sends a compact 5-byte `0x58` frame with weight at bytes `[3-4]` BE, not the 6+ byte BF700/BF800 layout the adapter assumed. The adapter rejected every live weight frame as too short and then mis-parsed the `0x59` finalize frame. Now branches on `isBf710Type` and applies a 3-reading stability window (0.3 kg tolerance) so the scale's initial metadata frame does not trigger early completion ([#112](https://github.com/KristianP26/ble-scale-sync/issues/112))


### Thanks

* [@flow778](https://github.com/flow778) for capturing raw BLE frames that made the fix possible ([#112](https://github.com/KristianP26/ble-scale-sync/issues/112))

## [1.8.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.8.0...v1.8.1) (2026-04-20)


### Fixed

* **Garmin**: upload failed with `'Garmin' object has no attribute 'garth'` after `garminconnect` released 0.3.0 on 2026-04-02, which dropped the `garth` dependency in favor of native authentication. The Python bridge accessed `garmin.garth.sess.headers` and `garmin.garth.dump()`, both removed in 0.3.x. Migrated to the new API: `Garmin.login(tokenstore)` auto-persists on successful credential login, and `client.dump(token_dir)` saves tokens after MFA. Custom User-Agent override is no longer needed because `garminconnect` now uses `curl_cffi` TLS impersonation and randomized browser fingerprints internally ([#114](https://github.com/KristianP26/ble-scale-sync/issues/114))
* **Docker**: added `libcurl4-openssl-dev` so `curl_cffi` (new transitive dep via `garminconnect` 0.3.x) builds from source on armv7, where PyPI has no prebuilt wheel


### Breaking

* Tokens from `garminconnect` 0.2.x (old garth OAuth1/OAuth2 files) are incompatible with 0.3.x. Existing installs must re-authenticate: `npm run setup-garmin`, or in the HA Add-on just restart the add-on so it re-runs setup from the credentials you entered. The setup script auto-removes leftover `oauth*_token.json` files before writing the new token format.


### Thanks

* [@Phipseyy](https://github.com/Phipseyy) and [@mooredav87](https://github.com/mooredav87) for reporting the Garmin upload regression ([#114](https://github.com/KristianP26/ble-scale-sync/issues/114))

## [1.8.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.7.5...v1.8.0) (2026-04-17)


### Added

* **HA Add-on**: one-click install via a [My Home Assistant](https://www.home-assistant.io/integrations/my/) badge in the README, landing page, getting-started guide, and HA Add-on guide. Manual steps remain as a fallback for users without My Home Assistant configured
* **HA Add-on**: `weight_unit` and `height_unit` exposed as add-on options (kg/lbs, cm/in). The CLI and exporters display in the chosen unit while internal math stays in kg/cm
* **HA Add-on**: `last_known_weight` persists across restarts. The runtime config lives at `/data/config.yaml` and a small Python helper (`merge_last_weights.py`) copies preserved per-user weights from the previous run into the freshly generated config on every startup, so multi-user identification by weight stays accurate after reboots and add-on updates
* **Docs**: new [Home Assistant Add-on guide](https://blescalesync.dev/guide/home-assistant-addon) covering install, full configuration reference, MQTT auto-detection, Garmin setup (including the MFA and IP-block workarounds), custom config mode, persistence semantics, and troubleshooting. Promoted to a first-class quick-start in the README and landing page

## [1.7.5](https://github.com/KristianP26/ble-scale-sync/compare/v1.7.4...v1.7.5) (2026-04-15)


### Fixed

* **HA Add-on**: Garmin Connect uploads now work out of the box. The add-on previously created an empty `/data/garmin-tokens/` directory and never ran the authentication step, so the first upload always failed with `No such file or directory: '/data/garmin-tokens/oauth1_token.json'`. On first start the add-on now runs `setup_garmin.py --from-config` to generate OAuth tokens from the email and password you entered in the UI ([#111](https://github.com/KristianP26/ble-scale-sync/issues/111))
* **Docker**: armv7 image builds failed because `cffi` (transitive dep via `garminconnect`) had no pre-built wheel for armv7 + Python 3.11 and pip could not compile from source. Added `python3-dev`, `libffi-dev`, and `libssl-dev` to the image so cffi builds cleanly


### Added

* **HA Add-on**: MFA-friendly token import. If your Garmin account uses 2FA, drop pre-generated `oauth1_token.json` and `oauth2_token.json` files into `/share/ble-scale-sync/garmin-tokens/` and the add-on imports them on startup, skipping the interactive auth that has no terminal inside an add-on container
* **HA Add-on**: DOCS.md now explains the full Garmin setup flow including the MFA workaround and the IP-block workaround


### Thanks

* [@Phipseyy](https://github.com/Phipseyy) for reporting the HA Add-on Garmin failure ([#111](https://github.com/KristianP26/ble-scale-sync/issues/111))

## [1.7.4](https://github.com/KristianP26/ble-scale-sync/compare/v1.7.3...v1.7.4) (2026-04-02)


### Fixed

* **QN Scale**: rewrote adapter as a notification-driven state machine for newer firmware (Renpho Elis 1, ES-CS20M) that requires an AE00 service handshake before measurement data flows ([#75](https://github.com/KristianP26/ble-scale-sync/issues/75), [#84](https://github.com/KristianP26/ble-scale-sync/issues/84))
* **QN Scale**: added ES-30M weight frame format detection (different byte layout for weight and impedance)
* **QN Scale**: 0x13 config byte now sends 0x01 (kg) instead of 0x08, which was switching the scale display to lb
* **QN Scale**: 2-second fallback timer for Linux (BlueZ D-Bus) where the initial 0x12 frame may be lost due to a CCCD subscription race condition
* **QN Scale**: skip impedance-less stable frames on ES-30M so the adapter waits for the full body composition reading


### Thanks

* [@DJBenson](https://github.com/DJBenson) for extensive macOS testing, packet capture analysis, and reverse-engineering the state machine flow ([#84](https://github.com/KristianP26/ble-scale-sync/issues/84))
* [@ericandreani](https://github.com/ericandreani) for persistent Linux/Docker testing across multiple iterations ([#75](https://github.com/KristianP26/ble-scale-sync/issues/75))

## [1.7.3](https://github.com/KristianP26/ble-scale-sync/compare/v1.7.2...v1.7.3) (2026-04-02)


### Fixed

* **Docker**: `diagnose` command was missing from the entrypoint, causing "exec: diagnose: not found" when running `docker run ... diagnose <MAC>` ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))


### Thanks

* [@mart1058](https://github.com/mart1058) for reporting the missing Docker diagnose command ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

## [1.7.2](https://github.com/KristianP26/ble-scale-sync/compare/v1.7.1...v1.7.2) (2026-04-01)


### Fixed

* **QN Scale**: UUID fallback (FFF0/FFE0) no longer matches named devices from other brands. Prevents Eufy, 1byone, and similar scales that share the FFF0 service from being incorrectly identified as QN Scale and failing with "Operation is not supported" ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))


### Thanks

* [@mart1058](https://github.com/mart1058) for reporting the Eufy P2 Pro connection failure ([#98](https://github.com/KristianP26/ble-scale-sync/issues/98))

## [1.7.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.7.0...v1.7.1) (2026-03-30)


### Fixed

* **Update check**: replaced strict 24-hour cooldown with calendar-day (UTC) comparison. Users who weigh in slightly earlier each day (e.g. 7:00 AM, then 6:55 AM) were being skipped

## [1.7.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.6.4...v1.7.0) (2026-03-29)


### Added

* **Update check** with anonymous usage statistics ([#87](https://github.com/KristianP26/ble-scale-sync/issues/87)). After each successful measurement (max once per 24h), the app checks `api.blescalesync.dev` for newer versions. Only the app version, OS, and architecture are sent via the User-Agent header. Disable with `update_check: false` in config.yaml. Automatically disabled in CI environments
* **Cloudflare Worker** (`worker/`) serving the `/version` endpoint and a public stats dashboard at [stats.blescalesync.dev](https://stats.blescalesync.dev) with aggregated anonymous data (version distribution, OS/architecture breakdown)
* Setup wizard shows an update notice before the first step if a newer version is available
* **CI**: GitHub Actions workflow for automatic Cloudflare Worker deployment on push to main (`worker.yml`)

## [1.6.4](https://github.com/KristianP26/ble-scale-sync/compare/v1.6.3...v1.6.4) (2026-03-27)


### Fixed

* **BLE**: use ATT Write Request instead of Reliable Write in node-ble handler, fixing "Operation is not supported" errors on Medisana BS430 and similar scales that do not support reliable writes ([#85](https://github.com/KristianP26/ble-scale-sync/issues/85))


### Improved

* **BLE**: GATT characteristic flags are now logged during discovery (`DEBUG=true`) for easier troubleshooting


### Thanks

* [@Ikari34](https://github.com/Ikari34) for reporting the Medisana BS430 issue ([#85](https://github.com/KristianP26/ble-scale-sync/issues/85))

## [1.6.3](https://github.com/KristianP26/ble-scale-sync/compare/v1.6.2...v1.6.3) (2026-03-04)


### Fixed

* **Docker**: removed cleanup workflow that was deleting multi-arch platform manifests, making all Docker images unpullable ([#74](https://github.com/KristianP26/ble-scale-sync/issues/74), [#76](https://github.com/KristianP26/ble-scale-sync/issues/76))


### Thanks

* [@marcelorodrigo](https://github.com/marcelorodrigo) for reporting the broken Docker images ([#74](https://github.com/KristianP26/ble-scale-sync/issues/74))
* [@mtcerio](https://github.com/mtcerio) for the additional report ([#76](https://github.com/KristianP26/ble-scale-sync/issues/76))

## [1.6.2](https://github.com/KristianP26/ble-scale-sync/compare/v1.6.1...v1.6.2) (2026-03-02)


### Changed

* **CI**: Docker `latest` tag now only applies to GitHub releases, not every push to main ([#70](https://github.com/KristianP26/ble-scale-sync/pull/70))
* **CI**: Removed push-to-main Docker build trigger ([#71](https://github.com/KristianP26/ble-scale-sync/pull/71))
* **Docs**: SEO meta keywords added to all documentation pages ([#69](https://github.com/KristianP26/ble-scale-sync/pull/69))
* **Docs**: Alternatives page updated with Strava, file export, and ESP32 proxy sections ([#68](https://github.com/KristianP26/ble-scale-sync/pull/68))
* **Docs**: ESP32 BLE proxy section added to getting started guide ([#67](https://github.com/KristianP26/ble-scale-sync/pull/67))

## [1.6.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.6.0...v1.6.1) (2026-03-01)


### Fixed

* **BlueZ stale discovery recovery** after Docker container restart. Adds kernel-level adapter reset via `btmgmt` as Tier 4 fallback when D-Bus recovery fails, plus proactive adapter reset in Docker entrypoint ([#39](https://github.com/KristianP26/ble-scale-sync/issues/39), [#43](https://github.com/KristianP26/ble-scale-sync/pull/43))


### Changed

* **CI**: Docker cleanup workflow removes PR images and untagged versions from GHCR ([#58](https://github.com/KristianP26/ble-scale-sync/pull/58))
* **Docs**: Contributors section added to README
* **Node.js**: minimum version bumped to 20.19.0 (required by eslint 10.0.2)
* **Deps**: @stoprocent/noble 2.3.16, eslint 10.0.2, typescript-eslint 8.56.1, @types/node 25.3.3, @inquirer/prompts 8.3.0


### Thanks

* [@marcelorodrigo](https://github.com/marcelorodrigo) for reporting the stale BlueZ discovery issue ([#39](https://github.com/KristianP26/ble-scale-sync/issues/39))

## [1.6.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.5.0...v1.6.0) (2026-02-28)


### Added

* **ESP32 BLE proxy** (experimental) for remote BLE scanning over MQTT. Use a cheap ESP32 board (~8€) as a wireless Bluetooth radio, enabling BLE Scale Sync on machines without local Bluetooth. Supports both broadcast and GATT scales
* **ESP32 display board** (Guition ESP32-S3-4848S040) with LVGL UI showing scan status, user matches, and export results
* **Beep feedback** on ESP32 boards with I2S buzzer (Atom Echo) when a known scale is detected
* **Streaming BLE scan** for ESP32-S3 boards with hardware radio coexistence
* **Docker mqtt-proxy compose** (`docker-compose.mqtt-proxy.yml`) requiring no BlueZ, D-Bus, or `NET_ADMIN`
* Setup wizard includes interactive mqtt-proxy configuration
* `BLE_HANDLER=mqtt-proxy` environment variable as alternative to config.yaml
* ESP32 proxy documentation page with architecture diagram, flashing guide, and MQTT topics reference


### Changed

* Renpho broadcast parsing consolidated into QN scale adapter
* Landing page updated with ESP32 proxy and Setup Wizard feature cards


### Thanks

* [@APIUM](https://github.com/APIUM) for the ESP32 MQTT proxy implementation ([#45](https://github.com/KristianP26/ble-scale-sync/pull/45))

## [1.5.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.4.0...v1.5.0) (2026-02-24)


### Added

* **File exporter** (CSV/JSONL) for local measurement logging without external services. Auto-header CSV with proper escaping, JSONL format, per-user file paths, and directory writability healthcheck
* **Strava exporter** with OAuth2 token management. Updates athlete weight via PUT /api/v3/athlete. Automatic token refresh, restricted file permissions (0o600), and interactive setup script (`npm run setup-strava`)
* Strava API application setup guide in documentation with step-by-step instructions

## [1.4.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.3.1...v1.4.0) (2026-02-24)


### Added

* **BLE diagnostic tool** (`npm run diagnose`) for detailed device analysis: advertisement data, service UUIDs, RSSI, connectable flag, and step-by-step GATT connection testing
* **Broadcast mode** for non-connectable QN-protocol scales (#34). Reads weight directly from BLE advertisement data without requiring a GATT connection
* **Garmin 2FA/MFA support** in `setup_garmin.py`. Prompts for authenticator code when Garmin requires multi-factor authentication


### Fixed

* **QN broadcast parser**: corrected byte layout (LE uint16 at bytes 17-18, stability flag at byte 15). Previous layout produced incorrect weight values
* **ES-CS20M**: service UUID 0x1A10 fallback for unnamed Yunmai-protocol devices (#34)
* **ES-CS20M**: 0x11 STOP frame support as stability signal (#34)


### Changed

* **CI**: Node.js 24 added to test matrix (required check)
* **CI**: PR-triggered Docker image builds with `pr-{id}` tags (#44)
* **Deps**: ESLint v10, typescript-eslint v8.56


### Thanks

* [@APIUM](https://github.com/APIUM) for Garmin 2FA support ([#41](https://github.com/KristianP26/ble-scale-sync/pull/41))
* [@Tosiman-Global](https://github.com/Tosiman-Global) and [@BenBaril83](https://github.com/BenBaril83) for debugging the ES-CS20M broadcast protocol (#34)
* [@marcelorodrigo](https://github.com/marcelorodrigo) for PR-triggered Docker builds ([#44](https://github.com/KristianP26/ble-scale-sync/pull/44))

## [1.3.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.2.2...v1.3.0) (2026-02-16)


### Added

* Garmin multi-user Docker authentication — `setup-garmin --user <name>` and `--all-users` commands
* `setup_garmin.py --from-config` mode reads users and credentials from `config.yaml`
* `--token-dir` argument for `garmin_upload.py` and `setup_garmin.py` — per-user token directories
* Tilde expansion for `token_dir` in TypeScript exporter
* 4 new Garmin exporter tests (token_dir passing, tilde expansion, backward compat)
* `pyyaml` dependency for config.yaml parsing in Python scripts
* Docker multi-user volume examples in `docker-compose.example.yml` and docs


### Fixed

* Friendly error message when D-Bus socket is not accessible (missing `-v /var/run/dbus:/var/run/dbus:ro` in Docker) instead of raw `ENOENT` crash (#25)


### Changed

* Wizard passes Garmin credentials via environment variables instead of CLI arguments (security)


### Thanks

* [@marcelorodrigo](https://github.com/marcelorodrigo) for [#29](https://github.com/KristianP26/ble-scale-sync/pull/29) — the initial implementation that inspired this solution

## [1.2.2](https://github.com/KristianP26/ble-scale-sync/compare/v1.2.1...v1.2.2) (2026-02-14)


### Added

* Annotated `config.yaml.example` with all sections and exporters
* `CONTRIBUTING.md` — development guide, project structure, test coverage, adding adapters/exporters, PR guidelines
* `CHANGELOG.md`
* GitHub Release and TypeScript badges
* Documentation split into `docs/` — exporters, multi-user, body-composition, troubleshooting


### Changed

* Rewrite README (~220 lines, Docker-first quick start, simplified scales table)
* Move dev content (project structure, test coverage, adding adapters/exporters) into CONTRIBUTING.md
* `.env.example` now notes that `config.yaml` is the preferred configuration method

## [1.2.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.2.0...v1.2.1) (2026-02-13)


### Added

* Docker support with multi-arch images (`linux/amd64`, `linux/arm64`, `linux/arm/v7`)
* `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.example.yml`
* GitHub Actions workflow for automated GHCR builds on release
* Docker health check via heartbeat file

## [1.2.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.1.0...v1.2.0) (2026-02-13)


### Added

* Interactive setup wizard (`npm run setup`) — BLE discovery, user profiles, exporter configuration, connectivity tests
* Edit mode — reconfigure any section without starting over
* Non-interactive mode (`--non-interactive`) for CI/automation
* Schema-driven exporter prompts — new exporters auto-appear in the wizard

## [1.1.0](https://github.com/KristianP26/ble-scale-sync/compare/v1.0.1...v1.1.0) (2026-02-13)


### Added

* Multi-user support — weight-based user matching (4-tier priority)
* Per-user exporters (override global for specific users)
* `config.yaml` as primary configuration format (`.env` fallback preserved)
* Automatic `last_known_weight` tracking (debounced, atomic YAML writes)
* Drift detection — warns when weight approaches range boundaries
* `unknown_user` strategy (`nearest`, `log`, `ignore`)
* SIGHUP config reload (Linux/macOS)
* Exporter registry with self-describing schemas
* Multi-user context propagation to all 5 exporters (MQTT topic routing, InfluxDB tags, Webhook fields, Ntfy prefix)

## [1.0.1](https://github.com/KristianP26/ble-scale-sync/compare/v1.0.0...v1.0.1) (2026-02-13)


### Changed

* Configuration is now `config.yaml`-first with `.env` as legacy fallback
* README rewritten for `config.yaml` workflow

## [1.0.0](https://github.com/KristianP26/ble-scale-sync/releases/tag/v1.0.0) (2026-02-12)


### Added

* Initial release
* 23 BLE scale adapters (QN-Scale, Xiaomi Mi Scale 2, Yunmai, Beurer, Sanitas, Medisana, and more)
* 5 export targets: Garmin Connect, MQTT (Home Assistant), Webhook, InfluxDB, Ntfy
* BIA body composition calculation (10 metrics)
* Cross-platform BLE support (Linux/node-ble, Windows/@abandonware/noble, macOS/@stoprocent/noble)
* Continuous mode with auto-reconnect
* Auto-discovery (no MAC address required)
* Exporter healthchecks at startup
* 894 unit tests across 49 test files
