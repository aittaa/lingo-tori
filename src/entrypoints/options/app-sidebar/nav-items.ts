export const ROUTE_DEFS = [
  { path: "/" },
  { path: "/byos" },
  { path: "/preference" },
  { path: "/shortcuts" },
  { path: "/api-providers" },
  { path: "/api-usage" },
  { path: "/custom-actions" },
  { path: "/page-translation" },
  { path: "/video-subtitles" },
  { path: "/floating-button" },
  { path: "/selection-toolbar" },
  { path: "/context-menu" },
  // Advanced is a sidebar GROUP with no page of its own; this path only exists
  // so links made before that change still land somewhere.
  { path: "/advanced" },
  // The first-run language question: opened by the background after a first install and by the
  // root route while it is pending. Internal, so the sidebar has no entry for it.
  { path: "/onboarding" },

  // Detail pages drilled into from a `ConfigNavItem`. They own no sidebar entry — the
  // sidebar lists its links itself — but route exactly like any other page.
  { path: "/advanced/glossary" },
  { path: "/advanced/glossary/:glossaryId" },
  { path: "/preference/config-backup" },
  { path: "/preference/extension-activation" },
  { path: "/page-translation/custom-css" },
  { path: "/page-translation/prompts" },
  { path: "/page-translation/translation-control" },
  { path: "/page-translation/translation-control/auto-translate-websites" },
  { path: "/page-translation/translation-control/never-auto-translate-websites" },
  { path: "/page-translation/translation-control/site-rules" },
  { path: "/page-translation/translation-queue" },
  { path: "/video-subtitles/style" },
  { path: "/video-subtitles/style/custom-css" },
  { path: "/video-subtitles/prompts" },
  { path: "/video-subtitles/subtitles-queue" },
] as const
