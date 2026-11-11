import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const rootArg = args.find((arg) => arg.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : repoRoot;
const unknownArgs = args.filter((arg) => arg !== '--check' && !arg.startsWith('--root='));

if (unknownArgs.length > 0 || args.filter((arg) => arg === '--check').length > 1) {
  console.error('Usage: node scripts/sync-version.mjs [--check] [--root=<project-root>]');
  process.exit(2);
}

function readRequired(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`required manifest missing: ${relativePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  return { filePath, text, originalText: text, optional: false };
}

function readOptional(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  return { filePath, text, originalText: text, optional: true };
}

function replaceExactlyOnce(text, regex, replacement, relativePath, field) {
  const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const matches = [...text.matchAll(globalRegex)];
  if (matches.length !== 1) {
    throw new Error(`${relativePath}: expected exactly one ${field} field, found ${matches.length}`);
  }
  return text.replace(regex, replacement);
}

function updateJsonField(entry, relativePath, field, value) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^\\s*"${escaped}"\\s*:\\s*")[^"]*("\\s*,?\\s*$)`, 'm');
  return replaceExactlyOnce(entry.text, regex, `$1${value}$2`, relativePath, field);
}

function planField(entry, relativePath, field, value) {
  return {
    ...entry,
    text: updateJsonField(entry, relativePath, field, value),
  };
}

try {
  const pkg = readRequired('package.json');
  const packageJson = JSON.parse(pkg.text);
  const version = packageJson.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('package.json: version must be a numeric stable x.y.z version without leading zeroes');
  }

  const plans = [];
  const tauriConfig = readRequired('src-tauri/tauri.conf.json');
  plans.push(planField(tauriConfig, 'src-tauri/tauri.conf.json', 'version', version));

  const iosConfig = readRequired('src-tauri/tauri.ios.conf.json');
  plans.push(planField(iosConfig, 'src-tauri/tauri.ios.conf.json', 'bundleVersion', version));

  const cargoToml = readRequired('src-tauri/Cargo.toml');
  const cargoPackage = cargoToml.text.match(/\[package\][\s\S]*?(?=\n\[|$)/)?.[0];
  if (!cargoPackage) throw new Error('src-tauri/Cargo.toml: [package] section missing');
  const cargoVersionRegex = /(^\s*version\s*=\s*")[^"]*("\s*$)/m;
  const updatedCargoPackage = replaceExactlyOnce(
    cargoPackage,
    cargoVersionRegex,
    `$1${version}$2`,
    'src-tauri/Cargo.toml',
    '[package].version',
  );
  plans.push({ ...cargoToml, text: cargoToml.text.replace(cargoPackage, updatedCargoPackage) });

  const cargoLock = readRequired('src-tauri/Cargo.lock');
  const lockPackageRegex = /(\[\[package\]\]\nname = "huangguo-client"\nversion = ")[^"]*(")/g;
  plans.push({
    ...cargoLock,
    text: replaceExactlyOnce(
      cargoLock.text,
      lockPackageRegex,
      `$1${version}$2`,
      'src-tauri/Cargo.lock',
      'huangguo-client package version',
    ),
  });

  const plistRelative = 'src-tauri/gen/apple/huangguo-client_iOS/Info.plist';
  const plist = readOptional(plistRelative);
  if (plist) {
    let updated = plist.text;
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      const regex = new RegExp(`(<key>${key}<\\/key>\\s*<string>)[^<]*(<\\/string>)`);
      updated = replaceExactlyOnce(updated, regex, `$1${version}$2`, plistRelative, key);
    }
    plans.push({ ...plist, text: updated });
  }

  const projectRelative = 'src-tauri/gen/apple/project.yml';
  const project = readOptional(projectRelative);
  if (project) {
    let updated = project.text;
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      const regex = new RegExp(`(^\\s*${key}:\\s*)"?[^\\r\\n"]+"?\\s*$`, 'm');
      updated = replaceExactlyOnce(updated, regex, `$1${version}`, projectRelative, key);
    }
    plans.push({ ...project, text: updated });
  }

  for (const { filePath, originalText } of plans) {
    if (fs.readFileSync(filePath, 'utf8') !== originalText) {
      throw new Error(`${path.relative(root, filePath)} changed while version synchronization was being prepared`);
    }
  }
  const drifted = plans.filter(({ text, originalText }) => text !== originalText);
  if (checkOnly) {
    if (drifted.length > 0) {
      console.error(`version drift from package.json (${version}): ${drifted.map(({ filePath }) => path.relative(root, filePath)).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log(`version manifests match package.json (${version})`);
    }
  } else {
    for (const { filePath, text } of drifted) fs.writeFileSync(filePath, text);
    console.log(drifted.length === 0
      ? `version manifests already match package.json (${version})`
      : `synchronized ${drifted.length} manifest(s) to package.json (${version})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
