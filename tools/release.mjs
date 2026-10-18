#!/usr/bin/env node
// Demo builds for Morrigan Labs, hosted as GitHub Releases on a public repo so
// anyone with the link can download them. Each release carries its expiry in a
// hidden marker in its notes, and `cleanup` (run twice an hour by
// .github/workflows/cleanup.yml) deletes the releases whose time is up.
// Needs Node 18+ and the GitHub CLI (gh), logged in with write access.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const REPO = process.env.RELEASES_REPO || process.env.GITHUB_REPOSITORY || 'JacopoDeRosa/morrigan-builds';
const HOUR = 3_600_000;
const DEFAULT_HOURS = 24;
// GitHub rejects release files of 2 GiB or more, so bigger builds go up in parts.
const PART_BYTES = Number(process.env.RELEASES_PART_BYTES) || 2000 * 1024 * 1024;
// Unity writes these folders next to every player build. They are debug data, not the game.
const NEVER_SHIP = ['_BurstDebugInformation_DoNotShip', '_BackUpThisFolder_ButDontShipItWithYourGame'];
const EXPIRES_MARKER = /<!--\s*expires:\s*(\S+)\s*-->/;

const USAGE = `Usage:
  node tools/release.mjs upload <file-or-folder> [--name "Lumen demo"] [--notes "What changed"] [--hours ${DEFAULT_HOURS} | --keep]
  node tools/release.mjs list
  node tools/release.mjs delete <tag>
  node tools/release.mjs cleanup

Folders are zipped first. A build deletes itself after --hours (default ${DEFAULT_HOURS});
--keep leaves it up until someone deletes it.`;

function gh(args, { stdio = 'pipe' } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw new Error(result.error.code === 'ENOENT'
      ? 'The GitHub CLI (gh) is not installed: https://cli.github.com'
      : result.error.message);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed${detail ? `:\n${detail}` : '.'}`);
  }
  return result.stdout ?? '';
}

function api(endpoint, ...flags) {
  const out = gh(['api', endpoint, ...flags]);
  return out.trim() ? JSON.parse(out) : null;
}

const releases = () => api(`repos/${REPO}/releases?per_page=100`, '--paginate', '--slurp').flat();

// When a release should go: the marker `upload` writes into its notes, or
// DEFAULT_HOURS after publishing for releases made on the GitHub website.
function expiryOf(release) {
  const marker = EXPIRES_MARKER.exec(release.body ?? '')?.[1];
  if (marker === 'never') return Infinity;
  const at = Date.parse(marker);
  if (!Number.isNaN(at)) return at;
  return Date.parse(release.published_at ?? release.created_at) + DEFAULT_HOURS * HOUR;
}

function remove(release) {
  gh(['api', '-X', 'DELETE', `repos/${REPO}/releases/${release.id}`]);
  try {
    gh(['api', '-X', 'DELETE', `repos/${REPO}/git/refs/tags/${release.tag_name}`]);
  } catch {
    // Drafts never got a tag, and a tag that is already gone is fine too.
  }
}

function deleteExpired() {
  const now = Date.now();
  const expired = releases().filter((release) => expiryOf(release) <= now);
  for (const release of expired) {
    remove(release);
    console.log(`Deleted ${release.tag_name}, which expired ${span(now - expiryOf(release))} ago.`);
  }
  return expired;
}

async function upload(target, { name, notes, hours, keep }) {
  const source = path.resolve(target);
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat) throw new Error(`Nothing at ${source}`);
  const lifetime = keep ? null : parseHours(hours);
  const title = name?.trim() || (stat.isDirectory() ? path.basename(source) : path.parse(source).name);

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'morrigan-build-'));
  try {
    let file = source;
    if (stat.isDirectory()) {
      file = path.join(work, `${safeFileName(path.basename(source))}.zip`);
      zip(source, file);
    }
    const { size } = await fsp.stat(file);
    const assets = size < PART_BYTES ? [file] : await split(file, size, work);

    const now = new Date();
    const expires = lifetime === null ? null : new Date(now.getTime() + lifetime * HOUR);
    const tag = `${slug(title)}-${stamp(now)}`;
    const notesFile = path.join(work, 'notes.md');
    await fsp.writeFile(notesFile, releaseNotes({ notes, expires, lifetime, parts: assets.length > 1 ? assets : null }));

    try {
      deleteExpired();
    } catch (error) {
      console.warn(`Couldn't clear out expired builds first (${error.message.split('\n')[0]}), uploading anyway.`);
    }

    console.log(`Uploading ${formatBytes(size)}${assets.length > 1 ? ` in ${assets.length} parts` : ''} to ${REPO}...`);
    gh(['release', 'create', tag, ...assets, '--repo', REPO, '--title', title, '--notes-file', notesFile], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const release = api(`repos/${REPO}/releases/tags/${tag}`);

    // GitHub switches scheduled workflows off in public repos after 60 days
    // without activity, so every upload switches the cleanup back on.
    try {
      gh(['api', '-X', 'PUT', `repos/${REPO}/actions/workflows/cleanup.yml/enable`]);
    } catch {
      console.warn('Could not make sure the cleanup workflow is on. Check the Actions tab.');
    }

    console.log(`\n${title} is up: ${release.html_url}`);
    for (const asset of release.assets.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${asset.browser_download_url}  (${formatBytes(asset.size)})`);
    }
    console.log(expires ? `It deletes itself ${formatDate(expires)}.` : 'It stays up until someone deletes it.');
    console.log(`Newest build, always: https://github.com/${REPO}/releases/latest`);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

function zip(folder, out) {
  // bsdtar writes real zips. GNU tar (first on PATH in Git Bash, the default on
  // Linux) would write a tarball with a .zip name, so only bsdtar is used.
  let tar;
  if (process.platform === 'win32') tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  else if (process.platform === 'darwin') tar = 'tar';
  else throw new Error('Zip the folder yourself on this OS, then upload the .zip.');

  for (const entry of fs.readdirSync(folder)) {
    if (NEVER_SHIP.some((suffix) => entry.endsWith(suffix))) console.log(`Leaving out ${entry} (Unity debug data).`);
  }
  console.log(`Zipping ${folder}...`);
  const excludes = NEVER_SHIP.flatMap((suffix) => ['--exclude', `*${suffix}`]);
  const result = spawnSync(tar, ['-a', '-c', '-f', out, ...excludes, '-C', path.dirname(folder), path.basename(folder)], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Zipping ${folder} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

async function split(file, size, work) {
  const name = safeFileName(path.basename(file));
  const parts = [];
  for (let start = 0, n = 1; start < size; start += PART_BYTES, n++) {
    const part = path.join(work, `${name}.${String(n).padStart(3, '0')}`);
    const end = Math.min(start + PART_BYTES, size) - 1;
    await pipeline(fs.createReadStream(file, { start, end }), fs.createWriteStream(part));
    parts.push(part);
  }
  if (path.dirname(file) === work) await fsp.rm(file);
  return parts;
}

function releaseNotes({ notes, expires, lifetime, parts }) {
  const lines = [];
  if (notes?.trim()) lines.push(notes.trim(), '');
  if (parts) {
    const names = parts.map((part) => path.basename(part));
    const whole = names[0].slice(0, -'.001'.length);
    lines.push(
      `**This build comes in ${parts.length} parts** because GitHub caps release files at 2 GiB. ` +
        `Download all of them into the same folder, then open \`${names[0]}\` with [7-Zip](https://www.7-zip.org/) ` +
        `to join them back into \`${whole}\`. Without 7-Zip, run this in Command Prompt in that folder:`,
      '',
      '```',
      `copy /b ${names.join('+')} ${whole}`,
      '```',
      '',
    );
  }
  if (expires) {
    lines.push(`This build deletes itself on **${formatDate(expires)}**, ${formatDuration(lifetime)} after upload.`);
    lines.push(`<!-- expires: ${expires.toISOString()} -->`);
  } else {
    lines.push('This build stays up until someone deletes it.');
    lines.push('<!-- expires: never -->');
  }
  return `${lines.join('\n')}\n`;
}

function list() {
  const now = Date.now();
  const all = releases();
  if (!all.length) return console.log(`No builds on ${REPO} right now.`);
  for (const release of all) {
    const expiry = expiryOf(release);
    const size = release.assets.reduce((sum, asset) => sum + asset.size, 0);
    const state = release.draft ? 'draft'
      : expiry === Infinity ? 'kept'
      : expiry <= now ? 'expired, deleting soon'
      : `expires in ${span(expiry - now)}`;
    console.log(`${release.tag_name}  "${release.name}"  ${formatBytes(size)}  ${state}`);
    console.log(`  ${release.html_url}`);
  }
}

function deleteByTag(tag) {
  const release = releases().find((candidate) => candidate.tag_name === tag);
  if (!release) throw new Error(`No release tagged ${tag} on ${REPO}.`);
  remove(release);
  console.log(`Deleted ${tag}.`);
}

function cleanup() {
  if (!deleteExpired().length) console.log('Nothing has expired.');
}

function parseHours(value) {
  const hours = value === undefined ? DEFAULT_HOURS : Number(value);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--hours needs a positive number, not "${value}".`);
  return hours;
}

const slug = (text) =>
  text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'build';

// GitHub renames assets with spaces or symbols in their names; this does it predictably instead.
const safeFileName = (name) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'build';

// 20261018-143205, in UTC so tags sort in upload order.
const stamp = (date) => date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

const formatDate = (date) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(date);

function formatDuration(hours) {
  if (hours >= 1) return `${+hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(hours * 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit && value < 10 ? 1 : 0)} ${units[unit]}`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      notes: { type: 'string' },
      hours: { type: 'string' },
      keep: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) return console.log(USAGE);
  if (values.keep && values.hours !== undefined) throw new Error('Use --hours or --keep, not both.');

  switch (command) {
    case 'upload':
      if (!arg) throw new Error('upload needs a file or folder.');
      return upload(arg, values);
    case 'list':
      return list();
    case 'delete':
      if (!arg) throw new Error('delete needs the tag of the release to delete (see `list`).');
      return deleteByTag(arg);
    case 'cleanup':
      return cleanup();
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
