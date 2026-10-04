"""I2S tone generation — pin-agnostic, reads config from board module.

Generates sine-wave tones at configurable frequency and duration.
No-ops gracefully on boards without a speaker (board.HAS_BEEP is False).
"""

import math
import struct
import board

_i2s = None
_SAMPLE_RATE = 8000

# Limits for values that arrive over MQTT. The tone is built in RAM (4 bytes
# per sample, 16 KB for 500 ms) and I2S.write blocks the caller's event loop
# for its whole length, so the worst case is 3 x 500 ms + 2 x 400 ms gaps.
# The server's patterns (src/runtime/processor.ts) stay well inside them.
MAX_DURATION_MS = 500
MAX_REPEAT = 3
MIN_FREQ = 20
MAX_FREQ = _SAMPLE_RATE // 2  # Nyquist: anything higher aliases
_GAP_MS = 400


def _clamp(value, low, high):
    return max(low, min(high, int(value)))


def init():
    """Configure I2S output using board-specific pin assignments."""
    global _i2s
    if not board.HAS_BEEP or board.BEEP_PINS is None:
        return
    from machine import I2S, Pin
    _i2s = I2S(
        0,
        sck=Pin(board.BEEP_PINS["sck"]),
        ws=Pin(board.BEEP_PINS["ws"]),
        sd=Pin(board.BEEP_PINS["sd"]),
        mode=I2S.TX,
        bits=16,
        format=I2S.STEREO,
        rate=_SAMPLE_RATE,
        ibuf=4000,
    )


def _generate_tone(freq, duration_ms):
    """Generate a stereo 16-bit PCM sine wave buffer."""
    n_samples = (_SAMPLE_RATE * duration_ms) // 1000
    buf = bytearray(n_samples * 4)  # 2 bytes/sample * 2 channels
    for i in range(n_samples):
        val = int(16000 * math.sin(2 * math.pi * freq * i / _SAMPLE_RATE))
        struct.pack_into("<hh", buf, i * 4, val, val)
    return buf


def beep(freq=1000, duration_ms=200, repeat=1):
    """Play a tone. Blocks until complete. Lazy-inits I2S on first call.

    freq, duration_ms and repeat are clamped to the limits above.
    """
    global _i2s
    if not board.HAS_BEEP:
        return
    freq = _clamp(freq, MIN_FREQ, MAX_FREQ)
    duration_ms = _clamp(duration_ms, 1, MAX_DURATION_MS)
    repeat = _clamp(repeat, 1, MAX_REPEAT)
    if _i2s is None:
        init()
        if _i2s is None:
            return
    tone = _generate_tone(freq, duration_ms)
    silence = _generate_tone(0, _GAP_MS) if repeat > 1 else None
    for i in range(repeat):
        _i2s.write(tone)
        if silence and i < repeat - 1:
            _i2s.write(silence)
