---
"@lingotori/extension": patch
---

fix(page-translation): when a translation-only answer breaks the attribute markers, ask again without the page's links, ids, styles and data attributes, as the first request already did, instead of sending the page's full HTML
