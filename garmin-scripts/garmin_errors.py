"""Error rendering shared by the Garmin setup and upload scripts."""


def format_error_chain(exc):
    """Render an exception together with the causes chained behind it.

    garminconnect wraps the real failure: the surface message is often
    "Failed to retrieve social profile" while the cause carries the status
    code that explains it (401 rejected token, 403 bot challenge, 429 rate
    limit). Printing only str(exc) discarded exactly the detail that tells a
    stale token apart from a real IP block, which sent people re-running the
    setup from another network for a problem another network could not fix.
    """
    parts = [f"{exc}"]
    seen = {id(exc)}
    cause = exc.__cause__ or exc.__context__
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        parts.append(f"  caused by: {type(cause).__name__}: {cause}")
        cause = cause.__cause__ or cause.__context__
    return "\n".join(parts)
