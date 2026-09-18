/**
 * Root of the namespace where Mac writes keep replaced versions, staged copies and the native
 * Trash. It lives on the user's real storage but is fdrive's own bookkeeping, so the desktop
 * routes refuse it and the web listing hides it. Kept in its own module because the desktop
 * files module imports from the fs routes, which also need this path.
 */
export const DESKTOP_INTERNAL_ROOT = "/.fdrive-desktop";
