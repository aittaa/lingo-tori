---
"@lingotori/extension": patch
---

fix(popup): keep the Translate button (and the context-menu title) on "Translate" when the page translation manager receives a start but refuses it (same source and target language, missing provider or key, cancelled by an OFF), instead of showing the page as translated
