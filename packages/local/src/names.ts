/**
 * A username is a folder name under the root. Starting with a letter or
 * digit keeps every home visible and clear of fdrive's own dotfiles; the
 * rest is the character set SFTPGo allowed, so its users carried over.
 */
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@~-]{0,254}$/;

/** True when `username` can name a local user and their home folder. */
export function isLocalUsername(username: string): boolean {
  return USERNAME.test(username);
}
