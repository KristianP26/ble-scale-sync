#!/usr/bin/env python3
"""Preserve per-user last_known_weight across add-on restarts.

Reads the previously persisted config.yaml and the freshly generated one,
copies last_known_weight per slug from old to new, and writes the merged
result back to the persistent path.
"""
import sys
import yaml


def load(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data if isinstance(data, dict) else {}


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: merge_last_weights.py <fresh> <persistent>", file=sys.stderr)
        return 2

    fresh_path, persistent_path = sys.argv[1], sys.argv[2]

    new = load(fresh_path)

    try:
        old = load(persistent_path)
    except FileNotFoundError:
        old = {}

    old_weights = {}
    for u in old.get("users") or []:
        slug = u.get("slug")
        weight = u.get("last_known_weight")
        if slug and weight is not None:
            old_weights[slug] = weight

    merged = 0
    for u in new.get("users") or []:
        slug = u.get("slug")
        if slug in old_weights:
            u["last_known_weight"] = old_weights[slug]
            merged += 1

    with open(persistent_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(new, f, sort_keys=False, allow_unicode=True)

    if merged:
        print(f"Preserved last_known_weight for {merged} user(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
