// Integration smoke: verify the plugin survives the GUI's real staging path.
// The GUI copies plugins/<localSource> to a real on-disk staging dir (because a
// child pnpm cannot read inside app.asar) and installs that copy. This checks
// the staged copy still satisfies the engine's client contract.
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const src = path.join(repo, 'plugins', 'dsh-gui-last-session');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));

// Mirror copyDirRecursive from src/plugin-manager.js.
function copyDirRecursive(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const f = path.join(from, name);
    const t = path.join(to, name);
    if (fs.statSync(f).isDirectory()) copyDirRecursive(f, t);
    else fs.writeFileSync(t, fs.readFileSync(f));
  }
}
copyDirRecursive(src, staging);

const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
console.log('staged package :', pkg.name);
console.log('staged client  :', fs.existsSync(path.join(staging, pkg.exports['./client'])));
console.log('staged patch   :', fs.existsSync(path.join(staging, pkg.dsh.bundle.patch)));
console.log('staged lib     :', fs.existsSync(path.join(staging, pkg.main)));
console.log('no space in path:', !/\s/.test(staging));

// The staged client bundle must still register under __ModuleLoader__.
const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (r) => registrations.push(r) } };
require(path.join(staging, pkg.exports['./client']));
const ok = registrations.length === 1 && registrations[0].id === pkg.name;
console.log('bundle registers:', ok, registrations.length === 1 ? `(id=${registrations[0].id})` : '');
const ex = registrations[0].factory(() => { throw new Error('unexpected require'); });
console.log('exports apply  :', typeof ex.apply === 'function');
console.log('exports name   :', ex.name);

const allOk =
  fs.existsSync(path.join(staging, pkg.exports['./client'])) &&
  fs.existsSync(path.join(staging, pkg.dsh.bundle.patch)) &&
  fs.existsSync(path.join(staging, pkg.main)) &&
  ok &&
  typeof ex.apply === 'function';

fs.rmSync(staging, { recursive: true, force: true });
console.log(allOk ? '\nSTAGING INTEGRATION OK' : '\nSTAGING INTEGRATION FAILED');
process.exitCode = allOk ? 0 : 1;
