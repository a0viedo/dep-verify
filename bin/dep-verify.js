#!/usr/bin/env node
const argv = require('yargs').argv;
const { verify } = require('../lib/index');

if(argv.help) {
  console.log('dep-verify supports these parameters:');
  console.log('--package-lock file  -> the file you want to provide for your list of dependencies');
  console.log('--log-level level -> it can be "debug", "info" or "error"');
  console.log('--temp-dir directory -> the directory you want to use to download the temporary files');
  console.log('You can run `npx dep-verify --package-lock package-lock.json --log-level error --temp-dir /dev/null`');
}
if(argv['package-lock']) {
  verify(argv['package-lock'], argv['log-level'], argv['temp-dir']);
}

if(argv['yarn-lockfile']) {
  console.log('Not supported.');
  process.exit(1);
}
