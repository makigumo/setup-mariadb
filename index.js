const execSync = require("child_process").execSync;
const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');
const spawnSync = require('child_process').spawnSync;

function run(command) {
  console.log(command);
  let env = Object.assign({}, process.env);
  delete env.CI; // for Homebrew
  env.HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK = '1';
  execSync(command, {stdio: 'inherit', env: env});
}

function runSafe() {
  const args = Array.from(arguments);
  console.log(args.join(' '));
  const command = args.shift();
  // spawn is safer and more lightweight than exec
  const ret = spawnSync(command, args, {stdio: 'inherit'});
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
const rollingReleaseVersion = ['11.5'];
const longTermVersions = ['11.4', '10.11', '10.6', '10.5'];
const shortTermVersions = ['11.2', '11.1'];

const supportedVersions = [...longTermVersions, ...shortTermVersions, ...rollingReleaseVersion];

const defaultVersion = longTermVersions[0];
const mariadbVersion = process.env['INPUT_MARIADB-VERSION'] || defaultVersion;

if (!supportedVersions.includes(mariadbVersion)) {
  throw 'Invalid MariaDB version: ' + mariadbVersion;
}

const database = process.env['INPUT_DATABASE'];

let bin;

if (isMac()) {
  const formula = `mariadb@${mariadbVersion}`;
  if (!formulaPresent(formula)) {
    run('brew update');
  }

  // install
  run(`brew install ${formula}`);

  // start
  const prefix = process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local';
  bin = `${prefix}/opt/${formula}/bin`;
  run(`${bin}/mysql.server start`);

  addToPath(bin);

  // add permissions
  if (mariadbVersion === '10.3') {
    run(`${bin}/mysql -u root -e "GRANT ALL PRIVILEGES ON *.* TO ''@'localhost'"`);
    run(`${bin}/mysql -u root -e "FLUSH PRIVILEGES"`);
  }
} else if (isWindows()) {
  // install
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mariadb-'));
  process.chdir(tmpDir);
  const versionMap = {
    '11.5': '11.5.2',
    '11.4': '11.4.3',
    '11.2': '11.2.5',
    '11.1': '11.1.6',
    '10.11': '10.11.9',
    '10.6': '10.6.19',
    '10.5': '10.5.26'
  };
  const fullVersion = versionMap[mariadbVersion];
  run(`curl -Ls -o mariadb.msi https://downloads.mariadb.com/MariaDB/mariadb-${fullVersion}/winx64-packages/mariadb-${fullVersion}-winx64.msi`);
  run(`msiexec /i mariadb.msi SERVICENAME=MariaDB /qn`);

  bin = `C:\\Program Files\\MariaDB ${mariadbVersion}\\bin`;
  addToPath(bin);

  // add user
  run(`"${bin}\\mysql" -u root -e "CREATE USER 'runneradmin'@'localhost' IDENTIFIED BY ''"`);
  run(`"${bin}\\mysql" -u root -e "GRANT ALL PRIVILEGES ON *.* TO 'runneradmin'@'localhost'"`);
  run(`"${bin}\\mysql" -u root -e "FLUSH PRIVILEGES"`);
} else {
  const image = process.env['ImageOS'];
  if (image == 'ubuntu20' || image == 'ubuntu22' || image == 'ubuntu24') {
    // clear previous data
    run(`sudo systemctl stop mysql.service`);
    run(`sudo rm -rf /var/lib/mysql`);
  }

  // install
  const ubuntuReleaseName = function() {
    switch (image) {
      case 'image20':
        return 'focal';
      case 'image22':
        return 'jammy';
      case 'image20':
        return 'noble';
      default:
        return execSync('. /etc/os-release && echo $VERSION_CODENAME');
    }
  };
  run(`sudo apt-key adv --recv-keys --keyserver hkp://keyserver.ubuntu.com:80 0xF1656F24C74CD1D8`);
  run(`cat << EOF
X-Repolib-Name: MariaDB
Types: deb
URIs: https://deb.mariadb.org/${mariadbVersion}/ubuntu
Suites: ${ubuntuReleaseName()}
Components: main main/debug
Signed-By: /etc/apt/keyrings/mariadb-keyring.pgp
EOF | sudo tee /etc/apt/sources.list.d/mariadb.sources`);
  run(`sudo apt-get update -o Dir::Etc::sourcelist="sources.list.d/mariadb.sources" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0"`);
  const install_package = ['11.5', '11.4', '11.2', '11.1', '10.11'].includes(mariadbVersion) ? `mariadb-server` : `mariadb-server-${mariadbVersion}`;
  run(`sudo apt-get install ${install_package}`);

  // start
  run(`sudo systemctl start mariadb`);

  // remove root password
  run(`sudo mysqladmin -proot password ''`);

  // add user
  run(`sudo mysql -e "CREATE USER '$USER'@'localhost' IDENTIFIED BY ''"`);
  run(`sudo mysql -e "GRANT ALL PRIVILEGES ON *.* TO '$USER'@'localhost'"`);
  run(`sudo mysql -e "FLUSH PRIVILEGES"`);


  bin = `/usr/bin`;
}

if (database) {
  runSafe(path.join(bin, 'mysqladmin'), 'create', database);
}
