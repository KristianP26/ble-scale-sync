"""I2S tone generation for M5Stack Atom Echo (NS4168 DAC).

Pins: BCLK=GPIO19, WS=GPIO33, DOUT=GPIO22.
Generates sine-wave tones at configurable frequency and duration.
"""

import math
import struct
from machine import I2S, Pin

_i2s = None
_SAMPLE_RATE = 8000


def init():
    """Configure I2S output for the NS4168 DAC."""
    global _i2s
    _i2s = I2S(
        0,
        sck=Pin(19),
        ws=Pin(33),
        sd=Pin(22),
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
    if _i2s is None:
        init()
    tone = _generate_tone(freq, duration_ms)
    silence = _generate_tone(0, 400) if repeat > 1 else None
    for i in range(repeat):
        _i2s.write(tone)
        if silence and i < repeat - 1:
            _i2s.write(silence)
