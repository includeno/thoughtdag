import desktop from '../../desktop/package.json';

const { owner, repo } = desktop.build.publish;
export const releaseRepository = `https://github.com/${owner}/${repo}`;
export const releaseApi = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
export const releaseDownload = `${releaseRepository}/releases/latest`;

/** Only stable, strictly newer releases belong to this desktop channel. */
export function isNewerRelease(current: string, candidate: string): boolean {
  const parse = (value: string) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number);
  const a = parse(current), b = parse(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return b[i] > a[i]; }
  return false;
}
