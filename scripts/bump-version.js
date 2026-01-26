#!/usr/bin/env node
/**
 * Auto-increment patch version on build
 * Updates: src/version.ts, package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function incrementVersion(version) {
  const parts = version.split('.');
  parts[2] = String(parseInt(parts[2], 10) + 1);
  return parts.join('.');
}

function updateFile(filePath, updateFn) {
  const content = readFileSync(filePath, 'utf-8');
  const updated = updateFn(content);
  writeFileSync(filePath, updated, 'utf-8');
  return updated;
}

// Read current version from package.json
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const currentVersion = packageJson.version;
const newVersion = incrementVersion(currentVersion);

console.log(`Bumping version: ${currentVersion} -> ${newVersion}`);

// Update package.json
packageJson.version = newVersion;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
console.log('  Updated: package.json');

// Update src/version.ts
const versionTsPath = join(rootDir, 'src', 'version.ts');
updateFile(versionTsPath, (content) =>
  content.replace(/APP_VERSION = "[^"]+"/,  `APP_VERSION = "${newVersion}"`)
);
console.log('  Updated: src/version.ts');

// Update src-tauri/tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = newVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf-8');
console.log('  Updated: src-tauri/tauri.conf.json');

// Update src-tauri/Cargo.toml
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
updateFile(cargoTomlPath, (content) =>
  content.replace(/^version = "[^"]+"/m, `version = "${newVersion}"`)
);
console.log('  Updated: src-tauri/Cargo.toml');

console.log(`\nVersion bumped to ${newVersion}`);
