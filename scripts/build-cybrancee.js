/**
 * Cybrancee package — flat root files only:
 *   index.js, appPack.js, package.json, .env
 * Bootstrap extracts appPack into /home/container and re-extracts when PACK_VERSION changes.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PACK_VERSION = '7';
const root = path.join(__dirname, '..');
const downloads = path.join(root, '..');
const outZip = path.join(downloads, 'megapithacus-cybrancee-v7.zip');
const staging = path.join(downloads, 'megapithacus-cybrancee-staging');
const appStage = path.join(downloads, 'megapithacus-cybrancee-app');

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
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

rm(staging);
rm(appStage);
fs.mkdirSync(staging, { recursive: true });
fs.mkdirSync(appStage, { recursive: true });

copyDir(path.join(root, 'src'), appStage);
fs.renameSync(path.join(appStage, 'index.js'), path.join(appStage, 'boot.js'));
fs.writeFileSync(path.join(appStage, 'PACK_VERSION'), PACK_VERSION, 'utf8');

const dataSrc = path.join(root, 'data');
const dataDest = path.join(appStage, 'data');
fs.mkdirSync(dataDest, { recursive: true });
if (fs.existsSync(dataSrc)) {
  for (const name of fs.readdirSync(dataSrc)) {
    fs.copyFileSync(path.join(dataSrc, name), path.join(dataDest, name));
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
pkg.main = 'index.js';
pkg.scripts = { start: 'node index.js', deploy: 'node deploy-commands.js' };
fs.writeFileSync(path.join(appStage, 'package.json'), JSON.stringify(pkg, null, 2));

const rawTgz = path.join(downloads, 'megapithacus-app-raw.tgz');
if (fs.existsSync(rawTgz)) fs.unlinkSync(rawTgz);
execFileSync('tar', ['-czf', rawTgz, '-C', appStage, '.'], { stdio: 'inherit' });

const b64 = fs.readFileSync(rawTgz).toString('base64');
fs.writeFileSync(
  path.join(staging, 'appPack.js'),
  `// Auto-generated bot payload v${PACK_VERSION} — do not edit\nmodule.exports = Buffer.from('${b64}', 'base64');\nmodule.exports.PACK_VERSION = '${PACK_VERSION}';\n`,
  'utf8'
);
fs.unlinkSync(rawTgz);

const bootstrap = `const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPECTED_VERSION = '${PACK_VERSION}';
const root = __dirname;
const versionFile = path.join(root, 'PACK_VERSION');
const marker = path.join(root, 'commands', 'help.js');
const banStore = path.join(root, 'services', 'banStore.js');
const tarball = path.join(root, 'app-extract.tgz');

function currentVersion() {
  try {
    return fs.readFileSync(versionFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function needsExtract() {
  if (!fs.existsSync(marker) || !fs.existsSync(banStore)) return true;
  return currentVersion() !== EXPECTED_VERSION;
}

function extract() {
  let pack;
  try {
    // Clear require cache so a replaced appPack.js is picked up
    const packPath = require.resolve('./appPack.js');
    delete require.cache[packPath];
    pack = require('./appPack.js');
  } catch (err) {
    console.error('Missing appPack.js next to index.js.');
    console.error('Upload megapithacus-cybrancee-v7.zip and extract ALL files into /home/container.');
    console.error('Required: index.js, appPack.js, package.json, .env');
    process.exit(1);
  }

  const buf = Buffer.isBuffer(pack) ? pack : pack?.default;
  if (!Buffer.isBuffer(buf) || buf.length < 100) {
    console.error('appPack.js is empty or invalid. Re-upload megapithacus-cybrancee-v7.zip.');
    process.exit(1);
  }

  console.log('Megapithacus: extracting app pack v' + EXPECTED_VERSION + ' (' + buf.length + ' bytes)…');
  fs.writeFileSync(tarball, buf);

  try {
    execFileSync('tar', ['-xzf', tarball, '-C', root], { stdio: 'inherit' });
  } catch (err) {
    console.error('tar extract failed:', err.message);
    process.exit(1);
  }

  try { fs.unlinkSync(tarball); } catch (_) {}
  fs.writeFileSync(versionFile, EXPECTED_VERSION, 'utf8');

  if (!fs.existsSync(marker)) {
    console.error('Extract finished but commands/help.js is still missing.');
    try { console.error('Files here:', fs.readdirSync(root).join(', ')); } catch (_) {}
    process.exit(1);
  }
  console.log('Megapithacus: extract complete → data dir will be', path.join(root, 'data'));
}

if (needsExtract()) {
  extract();
}

// Ensure data lives under the container root
process.env.DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
require(path.join(root, 'boot.js'));
`;

fs.writeFileSync(path.join(staging, 'index.js'), bootstrap, 'utf8');
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2));

if (fs.existsSync(path.join(root, 'package-lock.json'))) {
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(staging, 'package-lock.json'));
}
if (fs.existsSync(path.join(root, '.env'))) {
  fs.copyFileSync(path.join(root, '.env'), path.join(staging, '.env'));
}
if (fs.existsSync(path.join(root, '.env.example'))) {
  fs.copyFileSync(path.join(root, '.env.example'), path.join(staging, '.env.example'));
}

fs.writeFileSync(
  path.join(staging, 'README-UPLOAD.txt'),
  [
    'CYBRANCEE — megapithacus-cybrancee-v7.zip',
    '',
    '1. Stop server',
    '2. Delete EVERYTHING in /home/container',
    '3. Upload this zip and extract',
    '4. Confirm: index.js, appPack.js, package.json, .env',
    '5. Startup file = index.js',
    '6. Start',
    '',
    'Data is stored in /home/container/data (NOT /home/data).',
    '',
  ].join('\n'),
  'utf8'
);

if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

const ps = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = '${outZip.replace(/'/g, "''")}'
$staging = '${staging.replace(/'/g, "''")}'
if (Test-Path $zip) { Remove-Item $zip -Force }
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $staging -File -Force | ForEach-Object {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $_.Name)
  }
} finally { $archive.Dispose() }
Write-Output $zip
`;
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });

rm(appStage);
rm(staging);

// Quick path sanity check
const { dataDirFrom } = require(path.join(root, 'src', 'utils', 'paths'));
const fakeServices = path.join('/home/container/services');
const fakeSrcServices = path.join('/home/container/src/services');
console.log('Built:', outZip);
console.log('Size MB:', (fs.statSync(outZip).size / 1024 / 1024).toFixed(2));
console.log('Path check flat services →', dataDirFrom(fakeServices));
console.log('Path check src/services →', dataDirFrom(fakeSrcServices));
