---
"@lingotori/extension": patch
---

fix(config): keep custom headers, credential-named provider options and URL credentials (userinfo and secret query parameters) out of a config exported without API keys, and stop the export instead of writing the original if the credentials cannot be removed
