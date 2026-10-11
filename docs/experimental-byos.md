# Experimental BYOS status

BYOS means bring your own subscription. The browser-only ChatGPT provider experiment is tracked in [draft PR #12](https://github.com/aittaa/lingo-tori/pull/12), separately from the [independent BYOK core in draft PR #14](https://github.com/aittaa/lingo-tori/pull/14).

This core snapshot contains no selectable or executable BYOS provider. Previously stored experimental provider rows and feature assignments remain inert for compatibility; they do not start an account session or fall back automatically to a paid API. Use a configured BYOK provider explicitly in this core.

The separate BYOS draft is unfinished and has its own support and live-verification limits. Its existence does not establish that authentication, subscription access or live inference works for a given browser or account. No companion server, pairing key or service setup belongs to this core.

Follow the draft's current review status for experimental details. Do not interpret historical mixed-scope validation or this documentation as verification of that draft. For the available core configuration path, use the [BYOK setup guide](byok.md).
