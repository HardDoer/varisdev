const piEntryURL = import.meta.resolve('@earendil-works/pi-coding-agent');

/** Resolve shipped files from the application's pinned Pi dependency. */
export function pinnedPiModuleURL(path: string): URL {
  return new URL(path, piEntryURL);
}
