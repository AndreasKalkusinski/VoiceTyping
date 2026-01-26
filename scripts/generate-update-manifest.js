/**
 * Generate update manifest (latest.json) for Tauri updater
 * Run after building: node scripts/generate-update-manifest.js
 *
 * This script generates a latest.json file that should be uploaded
 * to GitHub releases along with the installer files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Read version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = packageJson.version;

// GitHub repo info
const GITHUB_OWNER = 'AndreasKalkusinski';
const GITHUB_REPO = 'VoiceTyping';

// Find the NSIS installer
const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
let nsisFile = null;

if (fs.existsSync(nsisDir)) {
  const files = fs.readdirSync(nsisDir);
  nsisFile = files.find(f => f.endsWith('-setup.exe'));
}

if (!nsisFile) {
  console.error('Error: NSIS installer not found. Run "npm run tauri:build" first.');
  process.exit(1);
}

// Generate the manifest
const manifest = {
  version: version,
  notes: `Voice Typing v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: '', // Will be added if signing is configured
      url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/${encodeURIComponent(nsisFile)}`
    }
  }
};

// Write the manifest
const outputPath = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'latest.json');
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));

console.log(`Generated update manifest: ${outputPath}`);
console.log(`Version: ${version}`);
console.log(`NSIS file: ${nsisFile}`);
console.log('');
console.log('Upload this file to your GitHub release:');
console.log(`  ${outputPath}`);
