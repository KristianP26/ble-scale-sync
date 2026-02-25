"""I2S tone generation — pin-agnostic, reads config from board module.

Generates sine-wave tones at configurable frequency and duration.
No-ops gracefully on boards without a speaker (board.HAS_BEEP is False).
"""

import math
import struct
import board

_i2s = None
_SAMPLE_RATE = 8000


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
    """Play a tone. Blocks until complete. Lazy-inits I2S on first call."""
    global _i2s
    if not board.HAS_BEEP:
        return
    if _i2s is None:
        init()
        if _i2s is None:
            return
    tone = _generate_tone(freq, duration_ms)
    silence = _generate_tone(0, 400) if repeat > 1 else None
    for i in range(repeat):
        _i2s.write(tone)
        if silence and i < repeat - 1:
            _i2s.write(silence)
