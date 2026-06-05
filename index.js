const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnSync = require('child_process').spawnSync;

function run() {
  const args = Array.from(arguments);
  console.log(args.map(v => v.toString().includes(' ') ? `"${v}"` : v).join(' '));
  const command = args.shift();
  let env = Object.assign({}, process.env);
  env.HOMEBREW_NO_AUTO_UPDATE = '1';
  env.HOMEBREW_NO_INSTALL_CLEANUP = '1';
  // spawn is safer and more lightweight than exec
  const ret = spawnSync(command, args, {stdio: 'inherit', env: env});
  if (ret.status !== 0) {
    throw ret.error;
  }
}

function addToPath(newPath) {
  fs.appendFileSync(process.env.GITHUB_PATH, `${newPath}\n`);
}

function isMac() {
  return process.platform === 'darwin';
}

function isWindows() {
  return process.platform === 'win32';
}

function formulaPresent(formula) {
  const tapPrefix = process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local/Homebrew';
  const tap = `${tapPrefix}/Library/Taps/homebrew/homebrew-core`;
  return fs.existsSync(`${tap}/Formula/${formula[0]}/${formula}.rb`) || fs.existsSync(`${tap}/Aliases/${formula}`);
}

// latest LTS release
const rollingReleaseVersion = ['13.0'];
const longTermVersions = ['12.3', '11.8', '11.4', '10.11', '10.6'];

const supportedVersions = [...longTermVersions, ...rollingReleaseVersion];

const defaultVersion = longTermVersions[0];
const mariadbVersion = process.env['INPUT_MARIADB-VERSION'] || defaultVersion;

if (!supportedVersions.includes(mariadbVersion)) {
  throw new Error('Invalid MariaDB version: ' + mariadbVersion);
}

const database = process.env['INPUT_DATABASE'];
const defaultUser = os.userInfo().username;
const user = process.env['INPUT_USER'] || defaultUser;
if (!/^[a-z0-9_-]+$/i.test(user)) {
  throw new Error(`Unsupported user: ${user}`);
}
const userExists = user === 'root' || (isMac() && user === defaultUser);

const prog = Number.parseFloat(mariadbVersion) >= 11 ? 'mariadb' : 'mysql';
const adminProg = Number.parseFloat(mariadbVersion) >= 11 ? 'mariadb-admin' : 'mysqladmin';

let bin, cmdPrefix;

if (isMac()) {
  const formula = `mariadb@${mariadbVersion}`;
  if (!formulaPresent(formula)) {
    run(`brew`, `update`, `--quiet`);
  }

  // install
  run(`brew`, `install`, `--quiet`, formula);

  // start
  const prefix = process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local';
  bin = `${prefix}/opt/${formula}/bin`;
  run(`${bin}/mysql.server`, `start`);

  addToPath(bin);

  cmdPrefix = [`${bin}/${prog}`];
} else if (isWindows()) {
  // install
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mariadb-'));
  process.chdir(tmpDir);
  const versionMap = {
    '13.0': '13.0.1',
    '12.3': '12.3.2',
    '11.8': '11.8.8',
    '11.4': '11.4.12',
    '10.11': '10.11.18',
    '10.6': '10.6.27',
  };
  const fullVersion = versionMap[mariadbVersion];
  run(`C:\\Windows\\System32\\curl.exe`, `-Ls`, `-o`, `mariadb.msi`, `https://dlm.mariadb.com/MariaDB/mariadb-${fullVersion}/winx64-packages/mariadb-${fullVersion}-winx64.msi`);
  run(`msiexec`, `/i`, `mariadb.msi`, `SERVICENAME=MariaDB`, `/qn`);

  bin = `C:\\Program Files\\MariaDB ${mariadbVersion}\\bin`;
  addToPath(bin);

  cmdPrefix = [`${bin}\\${prog}`, `-u`, `root`];
} else {
  if (process.arch !== 'arm64') {
    // clear previous data
    run(`sudo`, `systemctl`, `stop`, `mysql.service`);
    run(`sudo`, `rm`, `-rf`, `/var/lib/mysql`);
  }

  // install
  run(`sudo`, `mkdir`, `-p`, `/etc/apt/trusted.gpg.d`);
  run(`sudo`, `curl`, `-s`, `-o`, `/etc/apt/trusted.gpg.d/mariadb-keyring-2019.gpg`, `https://supplychain.mariadb.com/mariadb-keyring-2019.gpg`);
  const codename =  spawnSync(`lsb_release`, [`-cs`], {encoding: 'utf-8'}).stdout.trim();
  const mariadbList = `
 X-Repolib-Name: MariaDB
 Types: deb
 URIs: https://deb.mariadb.org/${mariadbVersion}/ubuntu
 Suites: ${codename}
 Components: main main/debug
 Signed-By: /etc/apt/trusted.gpg.d/mariadb-keyring-2019.gpg
`;
  spawnSync(`sudo`, [`tee`, `/etc/apt/sources.list.d/mariadb.sources`], {input: mariadbList});
  run(`sudo`, `apt-get`, `-qq`, `update`);

  const install_package = ['10.6'].includes(mariadbVersion) ? `mariadb-server-${mariadbVersion}` : `mariadb-server`;
  run(`sudo`, `apt-get`, `-qq`, `-o`, `Dpkg::Use-Pty=0`, `install`, install_package);

  // start
  run(`sudo`, `systemctl`, `start`, `mariadb`);

  // remove root password
  run(`sudo`, adminProg, `-proot`, `password`, ``);

  bin = `/usr/bin`;
  cmdPrefix = [`sudo`, prog];
}

if (!userExists) {
  run(...cmdPrefix, `-e`, `CREATE USER '${user}'@'localhost' IDENTIFIED BY ''`);
}
if (!userExists || (isMac() && user === 'root')) {
  run(...cmdPrefix, `-e`, `GRANT ALL PRIVILEGES ON *.* TO '${user}'@'localhost' IDENTIFIED BY ''`);
  run(...cmdPrefix, `-e`, `FLUSH PRIVILEGES`);
}

if (database) {
  run(path.join(bin, adminProg), `-u`, user, `create`, database);
}
