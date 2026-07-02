const { existsSync, copyFileSync } = require('fs');
const { join } = require('path');

const triples = {
  'linux-x64-gnu': 'linux-x64-gnu',
  'linux-arm64-gnu': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64-msvc': 'win32-x64-msvc',
};

function platformTriple() {
  const os = process.platform;
  const arch = process.arch;
  const key = `${os}-${arch}${os === 'linux' ? '-gnu' : ''}`;
  return triples[key];
}

const triple = platformTriple();
const nativeBinding = join(__dirname, `rwkv-bindings.${triple}.node`);

// Copy the compiled .so to the expected .node path if needed
const compiledSo = join(__dirname, 'rwkv-bindings', 'target', 'release', 'librwkv_bindings.so');
if (!existsSync(nativeBinding) && existsSync(compiledSo)) {
  copyFileSync(compiledSo, nativeBinding);
}

const addon = require(nativeBinding);
module.exports = addon;
