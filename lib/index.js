'use strict';

const path = require('path');
const fs = require('fs');
const util = require('util');
const url = require('url');
const targz = require('targz');
const request = require('request');
const rp = require('request-promise');
const find = require('find');
const pino = require('pino');
const sha1File = require('util').promisify(require('sha1-file'));
const decompress = util.promisify(targz.decompress);
let REGISTRY_BASE_URL = 'https://registry.npmjs.org';
let TEMP_DIR;
let logger;
Promise.any = require('promise-any');

module.exports.verify = async function(lockfilePath, logLevel, tempDirectory, registryUrl) {
  if(registryUrl) {
    REGISTRY_BASE_URL = registryUrl;
  }

  TEMP_DIR = tempDirectory;

  logger = pino({ level: logLevel || 'debug'});

  const lockfile = require(path.resolve(lockfilePath));
  const dependenciesWithDifferences = [];

  // TODO: add concurrency
  for (const [key, packageObj] of Object.entries(lockfile.dependencies)) {
    const packageInfo = await getPackageInfoFromRegistry(key);
    let ghDestinationPath;
    let npmDestinationPath;
    try {
      logger.info(`Starting checks for package ${key}`);
      const ghResponse = await downloadCompressedFileFromGitHub({ name: key, version: packageObj.version}, packageInfo);
      ghDestinationPath = ghResponse.path;
      const result = await downloadCompressedFileFromNpm({ name: key, version: packageObj.version});
      npmDestinationPath = result.path;

      const npmDecompressedDestination = path.resolve(TEMP_DIR, path.basename(npmDestinationPath, path.extname(npmDestinationPath)));
      const githubDecompressedDestination = path.resolve(TEMP_DIR, path.basename(ghDestinationPath, path.extname(ghDestinationPath)));
  
      if(!ghDestinationPath || !npmDestinationPath) {
        continue;
      }

      logger.debug(`decompressing package into ${npmDecompressedDestination}`);
      await decompress({ src: npmDestinationPath, dest: npmDecompressedDestination});
      await decompress({ src: ghDestinationPath, dest: githubDecompressedDestination});
      
      // TODO: move final directory mappings to variables
      const fileMapFromNPM = await getFileMap(`${npmDecompressedDestination}/package`);
      const fileMapFromGH = await getFileMap(`${githubDecompressedDestination}/${ghResponse.repo}-${packageObj.version}`);

      try {
        const differentFiles = [];
        for(let [mapKey, value] of Object.entries(fileMapFromNPM)) {
  
          // TODO: get hashes in parallel
          const hashNpm = await getHash(`${npmDecompressedDestination}/package${mapKey}`);
          const ghFilePath = `${githubDecompressedDestination}/${ghResponse.repo}-${packageObj.version}${mapKey}`
          const ghFileExists = await fileExists(ghFilePath);
          
          if(!ghFileExists) {
            logger.warn(`File '${mapKey}' for package ${key} doesn't exists in GitHub release. Could be a false positive...`);
            continue;
          }
          const hashGH = await getHash(ghFilePath);
          if(hashNpm !== hashGH) {
            logger.error(`Found different hashes for package "${key}" on path "${mapKey}" and version "${packageObj.version}"`);
            differentFiles.push(mapKey);
          }
        }

        if(differentFiles.length === 0) {
          logger.info(`All hashes matched for package ${key}`);
        } else {
          dependenciesWithDifferences.push([key, differentFiles.length]);
          logger.error(`Found ${differentFiles.length} files with different hashes for package ${key}.`);
        }
        
      } catch(err) {
        logger.error(`An error ocurred while verifying the ${key} package`, err.message);
      }
    } catch(e) {
      if(Array.isArray(e)) {
        if(e[0].message && e[0].message.includes('404')) {
          logger.error(`Couldn't download a tarball for ${key} package. Something might be wrong.`);
        } else {
          logger.error(`An error ocurred while trying to process ${key} package.`, `Error message: ${e.message}`);
        }
      } else {
        logger.error(`An error ocurred while trying to process ${key} package.`, `Error message: ${e.message}`);
      }
      continue;
    }
  }

  if(dependenciesWithDifferences.length === 0) {
    logger.info('Finished checking dependencies, no differences found.');
  } else {
    const message = dependenciesWithDifferences.map(([dep, count]) => `package "${dep}" had ${count} differences\n`).join('');
    logger.error(`Finished checking dependencies, found differences on the following packages:\n ${message}`);
  }
};

async function getPackageInfoFromRegistry(dependency) {
  return rp({
    uri: `${REGISTRY_BASE_URL}/${dependency}`,
    json: true
  });
}

async function downloadCompressedFileFromNpm(dependency){
  if(!dependency.version) {
    dependency.version = await getPackageLatestVersion(dependency.name);
  }

  const url = `${REGISTRY_BASE_URL}/${dependency.name}/-/${dependency.name}-${dependency.version}.tgz`;
  return {
    path: await downloadFile(url, `${dependency.name}-${dependency.version}-npm.tgz`),
    version: dependency.version
  };
}

function findFiles(regex, root) {
  return new Promise((resolve, reject) => {
    find.file(regex, root, result => {
      resolve(result);
    }).error(err => {
      reject(err);
    });
  });
}

async function getFileMap(path) {
  const result = {};
  const files = await findFiles(/\.js$/, path);
  files.forEach(file => {
    result[file.replace(path, '')] = true;
  });
  return result;
}

async function getHash(file) {
  return sha1File(file);
}

async function getPackageLatestVersion(name){
  const response = await request({
    json: true,
    url: `${REGISTRY_BASE_URL}/${name}`,
    method: 'GET'
  });

  return response['dist-tags'].latest;
}

async function downloadFile(url, fileName) {
  const destinationPath = path.resolve(TEMP_DIR, fileName);
  const writeStream = fs.createWriteStream(destinationPath);
  
  let errored = false;
  let statusCode;
  logger.debug(`downloading file ${url}`);
  return new Promise((resolve, reject) => {
    request.get(url).on('error', e => {
      logger.error(`there was an error downloading file ${url}: ${e.message}`);
      reject(e);
    })
      .on('response', (res) => {
        if(String(res.statusCode)[0] !== '2') {
          errored = true;
          statusCode = res.statusCode;
        }
      })
      .on('end', () => {
        if(errored) {
          return reject(new Error(statusCode));
        }
        logger.debug(`finished downloading file ${url}`);
        resolve(destinationPath);
      }).pipe(writeStream);
  });
}

async function downloadCompressedFileFromGitHub({ name, version }, packageInfo){
  if(!packageInfo.repository || !packageInfo.repository.url) {
    throw new Error(`package info doesn't contains repository info`);
  }
  const [x, githubUser, githubRepo] = url.parse(packageInfo.repository.url).pathname.split('/');
  const githubRepoName = path.basename(githubRepo, path.extname(githubRepo));
  
  // TODO: handle this error?
  const tarURL = `https://github.com/${githubUser}/${githubRepoName}/archive/v${version}.tar.gz`;
  const alternativeURL = `https://github.com/${githubUser}/${githubRepoName}/archive/${version}.tar.gz`;

  return {
    path: await Promise.any([downloadFile(tarURL, `${name}-${version}-gh.tgz`), downloadFile(alternativeURL, `${name}-${version}-gh.tar.gz`)]),
    repo: githubRepoName,
    user: githubUser
  };
}

function fileExists(filePath){
  return new Promise((resolve) => {
    fs.access(filePath, fs.F_OK, (err) => {
      if (err) {
        return resolve(false);
      }
      return resolve(true);
    });
  });
}

