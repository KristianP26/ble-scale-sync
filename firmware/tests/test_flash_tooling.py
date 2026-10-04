"""Guards for the host flashing tooling (PR #321).

esptool v5 renamed every command (`erase_flash` -> `erase-flash`) and moved from
`esptool.py` to a plain `esptool` console script. The old spellings still work
today but emit deprecation warnings and are scheduled for removal in the next
major release, so a reintroduced one would be a silent time bomb: these scripts
are never exercised in CI, only on a maintainer's desk with hardware attached.

The mip manifest name is guarded for a different reason. Dependabot's pip
fetcher treats any file whose name contains "requirements" as a pip manifest,
so naming the MicroPython package list `requirements.txt` inside a directory
covered by a pip ecosystem entry makes it try to resolve `aioble` against PyPI,
where an unrelated abandoned package of that name lives.

Run: python -m unittest discover -s firmware/tests
"""

import os
import re
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_ROOT = os.path.abspath(os.path.join(_FIRMWARE_DIR, ".."))

_SOURCES = [
    os.path.join(_FIRMWARE_DIR, "flash.sh"),
    os.path.join(_ROOT, "drivers", "build.sh"),
    os.path.join(_ROOT, "docs", "guide", "esp32-proxy.md"),
]

_LEGACY_ENTRY_POINT = re.compile(r"\besptool\.py\b")
_LEGACY_SUBCOMMANDS = re.compile(r"\b(erase_flash|write_flash|read_flash|chip_id|flash_id)\b")


def _read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


class FlashToolingTest(unittest.TestCase):
    def test_no_legacy_esptool_entry_point(self):
        for path in _SOURCES:
            self.assertTrue(os.path.exists(path), f"{path} is missing")
            self.assertIsNone(
                _LEGACY_ENTRY_POINT.search(_read(path)),
                f"{os.path.basename(path)} still calls esptool.py; "
                "esptool v5 uses the `esptool` console script",
            )

    def test_no_underscore_subcommands(self):
        for path in _SOURCES:
            self.assertIsNone(
                _LEGACY_SUBCOMMANDS.search(_read(path)),
                f"{os.path.basename(path)} still uses an underscore esptool subcommand; "
                "v5 spells them with hyphens",
            )

    def test_v5_command_names_present(self):
        text = _read(os.path.join(_FIRMWARE_DIR, "flash.sh"))
        for command in ("erase-flash", "write-flash", "chip-id"):
            self.assertIn(command, text, f"flash.sh no longer runs `{command}`")

    def test_mip_manifest_is_not_named_requirements(self):
        self.assertTrue(
            os.path.exists(os.path.join(_FIRMWARE_DIR, "mip-packages.txt")),
            "the MicroPython package list is missing",
        )
        self.assertFalse(
            os.path.exists(os.path.join(_FIRMWARE_DIR, "requirements.txt")),
            "firmware/requirements.txt would be picked up by the Dependabot pip ecosystem "
            "entry for /firmware, which must only ever see requirements-flash.txt",
        )

    def test_host_tools_are_pinned(self):
        text = _read(os.path.join(_FIRMWARE_DIR, "requirements-flash.txt"))
        pins = [
            line.strip()
            for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        self.assertTrue(pins, "requirements-flash.txt declares no host tools")
        for pin in pins:
            self.assertIn("==", pin, f"host tool `{pin}` is not pinned to an exact version")


_MIP_INSTALL = re.compile(r'mip install "?([^"\s]+)"?')


def _manifest_specs():
    text = _read(os.path.join(_FIRMWARE_DIR, "mip-packages.txt"))
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


class MipPackagePinTest(unittest.TestCase):
    """The device libraries flash.sh installs are pinned and match the manifest.

    The firmware relies on aioble internals (aioble.core.ble_irq, discovery and
    subscribe behaviour), so a plain `mip install aioble` could change them
    under an unchanged firmware. mpremote splits a spec at "@" into package and
    version, so `github:org/repo@<sha>/sub/dir` turns "<sha>/sub/dir" into the
    branch: the package.json resolves by accident, but every file in it is then
    fetched from <sha>/sub/dir/sub/dir and is not found.
    """

    def test_flash_sh_installs_exactly_the_manifest(self):
        flashed = _MIP_INSTALL.findall(_read(os.path.join(_FIRMWARE_DIR, "flash.sh")))
        self.assertTrue(flashed, "flash.sh installs no mip packages")
        self.assertEqual(flashed, _manifest_specs())

    def test_every_package_is_pinned(self):
        for spec in _manifest_specs():
            with self.subTest(spec=spec):
                self.assertEqual(spec.count("@"), 1, f"`{spec}` has no single @version pin")
                package, version = spec.split("@")
                self.assertTrue(version, f"`{spec}` has an empty version")
                if package.startswith("github:"):
                    self.assertNotIn("/", version, f"`{spec}`: the path must come before @")
                    self.assertRegex(version, r"^[0-9a-f]{7,40}$", f"`{spec}` is not pinned to a commit")
                else:
                    self.assertRegex(version, r"^\d+\.\d+\.\d+$", f"`{spec}` is not pinned to a release")

    def test_aioble_is_pinned(self):
        self.assertTrue(
            any(spec.startswith("aioble@") for spec in _manifest_specs()),
            "aioble is installed unpinned",
        )


if __name__ == "__main__":
    unittest.main()
