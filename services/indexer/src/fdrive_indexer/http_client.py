"""The pooled HTTP client every sidecar call shares.

`httpx.get` and friends build a throwaway client per call, which loads a TLS
context and opens a new connection each time: roughly 4 ms of CPU per request,
paid for every file a scan sends to Tika or an embedding service. One client
keeps connections alive across calls and is safe to share between threads.
"""

from __future__ import annotations

import httpx

shared = httpx.Client()
