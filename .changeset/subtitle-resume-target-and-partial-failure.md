---
"@lingotori/extension": patch
---

fix(subtitles): rebuild resumed subtitles when the target language changes and retry only cues whose translation failed

Switching subtitles off, changing the translation language and switching them on again no longer reuses translations in the old language. A cue whose request failed is no longer marked complete: it stays retryable on the next switch-on while translated cues are kept.
