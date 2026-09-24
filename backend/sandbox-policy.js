/**
 * SandboxPolicy — the single source of truth for the hardened terminal-session
 * container spec. Enforced at TWO seams:
 *   1. SessionLifecycle  — builds every create request FROM this policy (buildContainerSpec)
 *   2. ProxyValidator    — rejects any inbound Docker request that drifts FROM this policy
 *
 * Two consumers, one definition = a real seam (deletion test: delete this, two
 * modules regress and the spec can drift between them).
 *
 * NOTE: this file is intentionally policy DATA + a spec builder only. The
 * adversarial validation logic lives in proxy-validator (owned by that module).
 * Keep it dependency-free (no dockerode) so both the lifecycle module and the
 * validator import it without pulling the Docker client.
 */

const SESSION_LABEL_KEY = 'app';
const SESSION_LABEL_VALUE = 'terminal-portfolio';

// seccomp-default.json is Docker 29.3.0's default profile, verbatim (moby
// 83bca51, vendor/github.com/moby/profiles/seccomp/default.json). Sessions get
// it minus fallocate: fallocate(2) reserves real blocks instantly, so a single
// `fallocate -l 70G ~/x` would fill the host disk inside one tick of the
// writable-layer watchdog (SessionManager), which can only bound fills that
// proceed at disk-write speed. Everything else the default blocks stays blocked.
// EOPNOTSUPP rather than the default EPERM: glibc's posix_fallocate then falls
// back to ordinary writes, which the watchdog bounds, instead of failing.
const EOPNOTSUPP = 95;
const SECCOMP_PROFILE = (() => {
  const profile = JSON.parse(JSON.stringify(require('./seccomp-default.json')));
  for (const rule of profile.syscalls) {
    rule.names = rule.names.filter((name) => name !== 'fallocate');
  }
  profile.syscalls.push({ names: ['fallocate'], action: 'SCMP_ACT_ERRNO', errnoRet: EOPNOTSUPP });
  return profile;
})();

const SANDBOX_POLICY = Object.freeze({
  image: 'twaldin/terminal-portfolio:latest',
  hostname: 'twaldin',
  user: 'portfolio',
  workingDir: '/home/portfolio',
  label: Object.freeze({ [SESSION_LABEL_KEY]: SESSION_LABEL_VALUE }),
  env: Object.freeze([
    'TERM=xterm-256color',
    'PS1=tim.waldin.net:$ ',
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
  ]),
  // Codifies TODAY's verified-safe posture (live red-team 2026-07-22):
  //   - CapDrop ALL + CapAdd only SETUID/SETGID  -> root-in-container has 0xc0, no escape cap
  //   - NetworkMode none                         -> zero egress (verified curl_exit=7)
  //   - seccomp: Docker's default minus fallocate (SECCOMP_PROFILE); AppArmor at the daemon
  // Hardening follow-ups (daemon-level, NOT in this object): userns-remap,
  // storage quota, no-new-privileges (blocked by the sudo demo).
  hostConfig: Object.freeze({
    Memory: 512 * 1024 * 1024,
    // Equal to Memory: no swap. Docker's default (2x Memory) let each session
    // push 512 MB into the host's shared 2 GB swap.
    MemorySwap: 512 * 1024 * 1024,
    CpuQuota: 50000,
    PidsLimit: 100,
    ReadonlyRootfs: false,
    NetworkMode: 'none',
    CapDrop: Object.freeze(['ALL']),
    CapAdd: Object.freeze(['SETUID', 'SETGID']),
    Tmpfs: Object.freeze({ '/tmp': 'rw,noexec,nosuid,size=100m' }),
    // Output reaches the visitor only through the attach stream; nothing
    // reads `docker logs`. json-file made dockerd encode and write every
    // byte (up to ~1.5 MB per boot animation) for nothing.
    LogConfig: Object.freeze({ Type: 'none', Config: Object.freeze({}) }),
    SecurityOpt: Object.freeze([`seccomp=${JSON.stringify(SECCOMP_PROFILE)}`]),
  }),
});

/**
 * Build the exact dockerode createContainer() argument for a session container.
 * This is the ONLY place the container spec is constructed — both the warm-pool
 * path and the fresh-create path must call this, so the two never drift.
 * @param {string} sessionId - socket id (live) or 'pool' (pre-warm).
 * @returns {object} dockerode create payload.
 */
function buildContainerSpec(sessionId) {
  return {
    Image: SANDBOX_POLICY.image,
    Hostname: SANDBOX_POLICY.hostname,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    Env: [...SANDBOX_POLICY.env],
    WorkingDir: SANDBOX_POLICY.workingDir,
    User: SANDBOX_POLICY.user,
    Labels: { ...SANDBOX_POLICY.label, session: sessionId || 'pool' },
    HostConfig: {
      Memory: SANDBOX_POLICY.hostConfig.Memory,
      MemorySwap: SANDBOX_POLICY.hostConfig.MemorySwap,
      CpuQuota: SANDBOX_POLICY.hostConfig.CpuQuota,
      PidsLimit: SANDBOX_POLICY.hostConfig.PidsLimit,
      ReadonlyRootfs: SANDBOX_POLICY.hostConfig.ReadonlyRootfs,
      NetworkMode: SANDBOX_POLICY.hostConfig.NetworkMode,
      CapDrop: [...SANDBOX_POLICY.hostConfig.CapDrop],
      CapAdd: [...SANDBOX_POLICY.hostConfig.CapAdd],
      Tmpfs: { ...SANDBOX_POLICY.hostConfig.Tmpfs },
      LogConfig: { Type: SANDBOX_POLICY.hostConfig.LogConfig.Type, Config: {} },
      SecurityOpt: [...SANDBOX_POLICY.hostConfig.SecurityOpt],
    },
  };
}

/** Docker list/remove filter scoped to portfolio sessions — never global. */
function labelFilter() {
  return { label: [`${SESSION_LABEL_KEY}=${SESSION_LABEL_VALUE}`] };
}

module.exports = {
  SANDBOX_POLICY,
  SESSION_LABEL_KEY,
  SESSION_LABEL_VALUE,
  buildContainerSpec,
  labelFilter,
};
