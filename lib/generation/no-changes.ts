const FOLLOW_UP_NO_FILES =
  'No changes were made: the AI did not return any files for this request. Please try again, and describe the change in a little more detail — for example, name the page, section or component you want changed.';

export function describeNoChanges(input: {
  isEdit: boolean;
  hasProjectFiles: boolean;
  hasManifest: boolean;
  providersTried?: readonly string[];
}): string {
  if (input.isEdit && !input.hasProjectFiles) {
    return "No changes were made. I could not load this project's current files, so there was nothing to edit. Open the project preview so its workspace starts and its files load, then send this request again.";
  }
  if (input.isEdit && !input.hasManifest) {
    return "No changes were made. I could read this project's files but not work out how they fit together, so I could not tell which file to edit. Please send the request again and name the page or section you want changed.";
  }
  if (input.isEdit) return FOLLOW_UP_NO_FILES;

  const tried = (input.providersTried ?? []).filter(Boolean);
  const named = tried.length > 0 ? tried.join(', ') : 'the configured AI providers';
  return `The first build finished without any files. Every provider we tried (${named}) returned no files.`;
}
