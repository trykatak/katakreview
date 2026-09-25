/**
 * Back-compat shim for the pullfrog → katak rename.
 *
 * Consumer workflows written before the rename still set `PULLFROG_*`
 * environment variables (e.g. PULLFROG_MODEL, PULLFROG_FORCE_LOCAL_CLI).
 * Mirror them to their `KATAK_*` equivalents — only when the new name is not
 * already set, so new-style config always wins.
 *
 * Runs at module load. Import this BEFORE any module that reads env vars
 * (keep it the first import in entry.ts / entryPost.ts / cli.ts). Stdlib-only,
 * no imports: entryPost.ts must stay importable from a bare action checkout.
 */
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("PULLFROG_") || value === undefined) continue;
  const renamed = `KATAK_${key.slice("PULLFROG_".length)}`;
  if (process.env[renamed] === undefined) process.env[renamed] = value;
}
