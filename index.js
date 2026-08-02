/**
 * Root entry for hosts that default to index.js (Cybrancee / Pterodactyl).
 *
 * Primary update path: GitHub Action uploads a deploy tarball (src/ + this file)
 * then restarts the panel. Optional GitHub sync runs only when a token is set.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DEFAULT_REPO = 'LoSTxSteel/megapithacus';
const DEFAULT_BRANCH = 'cursor/admin-pay-board';

function shouldSync() {
  if (process.env.MEGAPITHACUS_GIT_SYNC === '0') return false;
  const token =
    process.env.MEGAPITHACUS_GIT_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';
  // Never attempt unauthenticated pulls — this repo is private.
  if (!token) return false;
  if (process.env.MEGAPITHACUS_GIT_SYNC === '1') return true;
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
  if (!shouldSync()) {
    if (!fs.existsSync(path.join(ROOT, 'src', 'index.js'))) {
      console.warn(
        'Git sync skipped (no MEGAPITHACUS_GIT_TOKEN). Relying on Action-deployed src/.'
      );
    }
    return;
  }

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

    const tarballUrl = `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(branch)}`;

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
  if (!fs.existsSync(srcEntry)) {
    console.error('Megapithacus: src/index.js not found.');
    console.error(
      'Push to GitHub so the restart Action can upload the deploy tarball, or set MEGAPITHACUS_GIT_TOKEN.'
    );
    process.exit(1);
  }
  // Do not fall back to legacy flat boot.js — that kept stale packs online
  // and re-registered slash commands without credit/reward.
  require(srcEntry);
}

syncFromGitHub()
  .catch((error) => console.warn('Git sync error:', error.message))
  .finally(boot);
