/**
 * Root entry for hosts that default to index.js (Cybrancee / Pterodactyl).
 *
 * On Pterodactyl/Cybrancee, pull the latest GitHub branch before boot so a
 * panel restart (from the GitHub Action) actually picks up new commands.
 * Local runs skip sync unless MEGAPITHACUS_GIT_SYNC=1.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DEFAULT_REPO = 'LoSTxSteel/megapithacus';
const DEFAULT_BRANCH = 'cursor/admin-pay-board';

function shouldSync() {
  if (process.env.MEGAPITHACUS_GIT_SYNC === '1') return true;
  if (process.env.MEGAPITHACUS_GIT_SYNC === '0') return false;
  if (process.env.P_SERVER_UUID) return true;
  return ROOT.replace(/\\/g, '/') === '/home/container';
}

function readState(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

async function githubJson(url, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Megapithacus',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function downloadToFile(url, dest, token) {
  const headers = { 'User-Agent': 'Megapithacus' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function syncFromGitHub() {
  if (!shouldSync()) return;

  const repo =
    process.env.MEGAPITHACUS_GIT_REPO ||
    process.env.GITHUB_REPOSITORY ||
    DEFAULT_REPO;
  const branch =
    process.env.MEGAPITHACUS_GIT_BRANCH ||
    process.env.GITHUB_REF_NAME ||
    DEFAULT_BRANCH;
  const token =
    process.env.MEGAPITHACUS_GIT_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';

  const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
  const stateFile = path.join(dataDir, 'git-sync.json');
  const state = readState(stateFile);

  let sha;
  try {
    const commit = await githubJson(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`,
      token
    );
    sha = commit.sha;
  } catch (error) {
    console.warn(`Git sync skipped (resolve failed): ${error.message}`);
    return;
  }

  if (state.sha === sha && fs.existsSync(path.join(ROOT, 'src', 'index.js'))) {
    console.log(`Git sync: already at ${sha.slice(0, 7)} (${branch})`);
    return;
  }

  const staging = path.join(ROOT, '.git-sync-tmp');
  const tarball = path.join(ROOT, '.git-sync.tgz');

  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    const tarballUrl = token
      ? `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(branch)}`
      : `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;

    console.log(`Git sync: downloading ${repo}@${branch} (${sha.slice(0, 7)})…`);
    await downloadToFile(tarballUrl, tarball, token);
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'inherit' });

    const top = fs.readdirSync(staging).find((name) => {
      try {
        return fs.statSync(path.join(staging, name)).isDirectory();
      } catch {
        return false;
      }
    });
    if (!top) throw new Error('Tarball had no top-level directory');

    const extracted = path.join(staging, top);
    const preserve = new Set([
      '.env',
      'data',
      'node_modules',
      'appPack.js',
      'PACK_VERSION',
      '.git-sync-tmp',
      '.git-sync.tgz',
    ]);

    for (const name of fs.readdirSync(extracted)) {
      if (preserve.has(name)) continue;
      const from = path.join(extracted, name);
      const to = path.join(ROOT, name);
      fs.rmSync(to, { recursive: true, force: true });
      if (fs.statSync(from).isDirectory()) copyDir(from, to);
      else fs.copyFileSync(from, to);
    }

    if (!fs.existsSync(path.join(ROOT, 'src', 'index.js'))) {
      throw new Error('Sync finished but src/index.js is missing');
    }

    writeState(stateFile, {
      sha,
      branch,
      repo,
      syncedAt: new Date().toISOString(),
    });
    console.log(`Git sync: updated to ${sha.slice(0, 7)} (${branch})`);
  } catch (error) {
    console.warn(`Git sync failed: ${error.message}`);
  } finally {
    try {
      fs.unlinkSync(tarball);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function boot() {
  const srcEntry = path.join(ROOT, 'src', 'index.js');
  const flatBoot = path.join(ROOT, 'boot.js');
  if (fs.existsSync(srcEntry)) {
    require(srcEntry);
    return;
  }
  if (fs.existsSync(flatBoot)) {
    require(flatBoot);
    return;
  }
  // Legacy flat layout (commands/ next to this file)
  if (fs.existsSync(path.join(ROOT, 'commands')) && fs.existsSync(path.join(ROOT, 'events'))) {
    // Old flat packages used index.js as the real bot — cannot re-enter this file.
    console.error(
      'Megapithacus: found flat commands/ but no src/index.js. Upload a fresh package or set MEGAPITHACUS_GIT_SYNC=1 with network access.'
    );
    process.exit(1);
  }
  console.error('Megapithacus: src/index.js not found after sync.');
  process.exit(1);
}

syncFromGitHub()
  .catch((error) => console.warn('Git sync error:', error.message))
  .finally(boot);
