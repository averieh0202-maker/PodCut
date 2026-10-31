/** Navigation must wait for a verified save. A rejected/failed save leaves the
 * editor open, so the user can retry without losing the current in-memory edit. */
export async function saveAndLeave(options: {
  save: () => Promise<boolean>;
  navigate: () => void;
}): Promise<boolean> {
  if (!await options.save()) return false;
  options.navigate();
  return true;
}
