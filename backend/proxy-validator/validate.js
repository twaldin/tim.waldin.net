'use strict';

// Docker treats non-positive resource limits as unlimited, so this validator
// considers them more generous than the finite limits in SANDBOX_POLICY.

const { SANDBOX_POLICY } = require('../sandbox-policy');

const ALLOWED_CAPABILITIES = new Set(['SETUID', 'SETGID']);
const HOST_NAMESPACE_FIELDS = [
  'UsernsMode',
  'PidMode',
  'IpcMode',
  'UTSMode',
  'CgroupParent',
];
const RESOURCE_FIELDS = ['Memory', 'PidsLimit', 'CpuQuota'];

function reject(reason) {
  throw new Error(`Sandbox policy violation: ${reason}`);
}

function isNonEmpty(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Assert that a Docker create-container request is no more permissive than the
 * frozen sandbox policy.
 * @param {object} createBody Docker create request body.
 * @returns {void}
 * @throws {Error} when the request violates the sandbox policy.
 */
function assertSandboxCompliant(createBody) {
  if (!createBody || typeof createBody !== 'object' || Array.isArray(createBody)) {
    reject('create body must be an object');
  }

  const hostConfig = createBody.HostConfig;
  if (!hostConfig || typeof hostConfig !== 'object' || Array.isArray(hostConfig)) {
    reject('HostConfig is required');
  }

  if (hostConfig.Privileged) reject('Privileged is forbidden');

  for (const field of ['Binds', 'Mounts', 'Devices']) {
    if (isNonEmpty(hostConfig[field])) reject(`${field} must be empty`);
  }

  if (hostConfig.NetworkMode !== 'none') {
    reject('NetworkMode must be none');
  }

  for (const field of HOST_NAMESPACE_FIELDS) {
    const value = hostConfig[field];
    if (value !== undefined && value !== null && value !== '') {
      reject(`${field} is forbidden`);
    }
  }

  if (hostConfig.CapAdd !== undefined && hostConfig.CapAdd !== null) {
    if (!Array.isArray(hostConfig.CapAdd)) reject('CapAdd must be an array');
    for (const capability of hostConfig.CapAdd) {
      if (!ALLOWED_CAPABILITIES.has(capability)) {
        reject(`CapAdd contains forbidden capability ${String(capability)}`);
      }
    }
  }

  if (!Array.isArray(hostConfig.CapDrop) || !hostConfig.CapDrop.includes('ALL')) {
    reject('CapDrop must include ALL');
  }

  if (hostConfig.SecurityOpt !== undefined && hostConfig.SecurityOpt !== null) {
    if (!Array.isArray(hostConfig.SecurityOpt)) reject('SecurityOpt must be an array');
    for (const option of hostConfig.SecurityOpt) {
      if (typeof option !== 'string') reject('SecurityOpt entries must be strings');
      const normalized = option.toLowerCase();
      if (normalized.includes('unconfined') || normalized.includes('no-new-privileges=false')) {
        reject(`unsafe SecurityOpt ${option}`);
      }
    }
  }

  if (createBody.Image !== SANDBOX_POLICY.image) {
    reject('Image does not match SANDBOX_POLICY');
  }

  for (const field of RESOURCE_FIELDS) {
    const requested = hostConfig[field];
    const maximum = SANDBOX_POLICY.hostConfig[field];
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
      reject(`${field} must be a finite positive limit`);
    }
    if (requested > maximum) {
      reject(`${field} exceeds SANDBOX_POLICY`);
    }
  }
}

module.exports = { assertSandboxCompliant };
