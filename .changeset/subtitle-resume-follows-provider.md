---
"@lingotori/extension": patch
---

fix(subtitles): rebuild a switched-off subtitle session when it is switched on after the subtitles provider or model was changed, so segmentation and line translation use the same provider instead of segmentation staying on the old one
