"""Error rendering shared by the Garmin setup and upload scripts."""

import re

# garminconnect redacts URL query values in its own messages because requests
# exceptions can carry an SSO service ticket (?ticket=ST-...). The chain below
# reaches the orchestrator log and gets pasted into issues, so the causes get
# the same treatment.
_QUERY_VALUE = re.compile(r"""([?&][\w.-]+=)[^&\s)'"]+""")


def _redact(text):
    return _QUERY_VALUE.sub(r"\1<redacted>", text)


def _next_link(exc):
    # `raise ... from None` sets __suppress_context__: the raiser chose to hide
    # the context, so it is not shown here either.
    if exc.__cause__ is not None:
        return exc.__cause__
    return None if exc.__suppress_context__ else exc.__context__


def format_error_chain(exc):
    """Render an exception together with the causes chained behind it.

    garminconnect wraps the real failure: the surface message is often
    "Failed to retrieve social profile" while the cause carries the status
    code that explains it (401 rejected token, 403 bot challenge, 429 rate
    limit). Printing only str(exc) discarded exactly the detail that tells a
    stale token apart from a real IP block, which sent people re-running the
    setup from another network for a problem another network could not fix.
    """
    parts = [_redact(f"{exc}")]
    seen = {id(exc)}
    cause = _next_link(exc)
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        parts.append(_redact(f"  caused by: {type(cause).__name__}: {cause}"))
        cause = _next_link(cause)
    return "\n".join(parts)
