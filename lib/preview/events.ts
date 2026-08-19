/**
 * Fired when a project's stored files change (a generation settled, a
 * checkpoint was restored). The preview listens for it and rebuilds, which is
 * how the iframe refreshes now that there is no dev server to hot-reload.
 */
export const PROJECT_FILES_CHANGED_EVENT = 'navroop:project-files-changed';
