// cellsh: one cell's session agent, the cell container's pid 1.
//
// A cell is a long-lived container running this image. The backend connects
// to cellsh's unix socket once per visitor; the connection is the sandbox's
// lifetime. On a spawn frame cellsh creates a cgroup leaf with the session's
// limits and clones a child into fresh pid/mount/net/ipc/uts namespaces. The
// child joins the leaf, unshares a cgroup namespace rooted there, builds a
// Docker-shaped root (an overlay over the cell's read-only rootfs with a
// tmpfs upper, then proc, dev, sys, cgroup, the session tmpfs mounts and
// Docker's masked/read-only paths), opens its console inside its own devpts,
// passes the pty master back, loads the session seccomp filter, drops to the
// session capability bounding set and user, and execs the shell. cellsh then
// relays bytes between the connection and the pty master. Closing the
// connection kills the leaf; the shell exiting closes the connection.
//
// Wire format, both directions: [type u8][length u32 big-endian][payload].
//   backend -> cell: S spawn policy, I input bytes, R "cols rows", U usage?
//   cell -> backend: K ready (leaf name), O output bytes, U used bytes,
//                    X "wait-status oom-kills", E error text

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <net/if.h>
#include <pwd.h>
#include <sched.h>
#include <seccomp.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <linux/capability.h>

#define CELL_DIR "/run/cell"
#define CG_ROOT CELL_DIR "/cg"
#define STAGE CELL_DIR "/stage"
#define NEWROOT STAGE "/root"
#define HIGH_WATER (1u << 20)
#define LOW_WATER (256u << 10)
#define MAX_FRAME (1u << 20)
#define READ_CHUNK 65536
#define HDR 5

enum { K_LISTEN = 1, K_SIGNAL, K_CONN, K_MASTER, K_SETUP };

struct ep {
  int kind;
  struct sess *s;
};

struct buf {
  char *p;
  size_t off, len, cap;
};

struct tmpfs_mount {
  char path[256];
  unsigned long flags;
  char data[128];
};

struct policy {
  char *raw;
  size_t rawlen;
  char hostname[65];
  char user[64];
  char cwd[PATH_MAX];
  char **env;
  size_t nenv;
  long long memory, swap, pids, rootfs;
  char cpu[64];
  uint64_t keep_caps;
  struct tmpfs_mount tmpfs[8];
  int ntmpfs;
  uid_t uid;
  gid_t gid;
  gid_t groups[64];
  int ngroups;
  scmp_filter_ctx seccomp;
};

struct sess {
  struct sess *next;
  unsigned id;
  int conn, master, root, setup;
  pid_t pid;
  int reaped, status, oom_kills;
  int closing;
  int throttled, conn_paused;
  uint32_t conn_events, master_events;
  int have_size;
  unsigned short cols, rows;
  char leaf[32];
  struct buf in, to_conn, to_master;
  struct ep e_conn, e_master, e_setup;
};

static int epfd;
static char **shell_argv;
static char **base_env;
static size_t base_nenv;
static struct rlimit orig_rlimits[RLIM_NLIMITS];
static int cap_last;
static unsigned next_id;
static struct sess *sessions;
static struct policy *cached;
// Sessions finished during one epoll batch; freed after it so later events in
// the same batch never touch freed memory.
static struct sess *dead;

static void flush_master(struct sess *s);

static void logf_(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fputs("cellsh: ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

static void die(const char *what) {
  logf_("%s: %s", what, strerror(errno));
  exit(1);
}

static void buf_reserve(struct buf *b, size_t extra) {
  if (b->off + b->len + extra <= b->cap) return;
  if (b->off) {
    memmove(b->p, b->p + b->off, b->len);
    b->off = 0;
  }
  if (b->len + extra <= b->cap) return;
  size_t cap = b->cap ? b->cap : 4096;
  while (cap < b->len + extra) cap *= 2;
  char *p = realloc(b->p, cap);
  if (!p) die("realloc");
  b->p = p;
  b->cap = cap;
}

static void buf_put(struct buf *b, const void *data, size_t n) {
  buf_reserve(b, n);
  memcpy(b->p + b->off + b->len, data, n);
  b->len += n;
}

static void buf_drop(struct buf *b, size_t n) {
  b->off += n;
  b->len -= n;
  if (!b->len) b->off = 0;
}

static void buf_free(struct buf *b) {
  free(b->p);
  memset(b, 0, sizeof *b);
}

static void put_header(char *h, char type, uint32_t len) {
  h[0] = type;
  h[1] = (char)(len >> 24);
  h[2] = (char)(len >> 16);
  h[3] = (char)(len >> 8);
  h[4] = (char)len;
}

static int write_file(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t n = strlen(text);
  ssize_t w = write(fd, text, n);
  int saved = errno;
  close(fd);
  errno = saved;
  return w == (ssize_t)n ? 0 : -1;
}

static int write_leaf(const char *leaf, const char *file, const char *text) {
  char path[PATH_MAX];
  snprintf(path, sizeof path, CG_ROOT "/%s/%s", leaf, file);
  return write_file(path, text);
}

/* ---------- policy ---------- */

static const char *const CAP_NAMES[] = {
  "CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID",
  "SETPCAP", "LINUX_IMMUTABLE", "NET_BIND_SERVICE", "NET_BROADCAST", "NET_ADMIN", "NET_RAW",
  "IPC_LOCK", "IPC_OWNER", "SYS_MODULE", "SYS_RAWIO", "SYS_CHROOT", "SYS_PTRACE", "SYS_PACCT",
  "SYS_ADMIN", "SYS_BOOT", "SYS_NICE", "SYS_RESOURCE", "SYS_TIME", "SYS_TTY_CONFIG", "MKNOD",
  "LEASE", "AUDIT_WRITE", "AUDIT_CONTROL", "SETFCAP", "MAC_OVERRIDE", "MAC_ADMIN", "SYSLOG",
  "WAKE_ALARM", "BLOCK_SUSPEND", "AUDIT_READ", "PERFMON", "BPF", "CHECKPOINT_RESTORE",
};

static int cap_number(const char *name) {
  if (!strncmp(name, "CAP_", 4)) name += 4;
  for (size_t i = 0; i < sizeof CAP_NAMES / sizeof *CAP_NAMES; i++)
    if (!strcmp(CAP_NAMES[i], name)) return (int)i;
  return -1;
}

static int parse_action(const char *text, uint32_t *action) {
  if (!strcmp(text, "allow")) {
    *action = SCMP_ACT_ALLOW;
    return 0;
  }
  if (!strncmp(text, "errno:", 6)) {
    char *end;
    long n = strtol(text + 6, &end, 10);
    if (*end || n < 0 || n > 4095) return -1;
    *action = SCMP_ACT_ERRNO((uint16_t)n);
    return 0;
  }
  return -1;
}

static int parse_op(const char *text, enum scmp_compare *op) {
  static const struct { const char *name; enum scmp_compare op; } ops[] = {
    {"NE", SCMP_CMP_NE}, {"LT", SCMP_CMP_LT}, {"LE", SCMP_CMP_LE}, {"EQ", SCMP_CMP_EQ},
    {"GE", SCMP_CMP_GE}, {"GT", SCMP_CMP_GT}, {"MASKED_EQ", SCMP_CMP_MASKED_EQ},
  };
  for (size_t i = 0; i < sizeof ops / sizeof *ops; i++)
    if (!strcmp(ops[i].name, text)) {
      *op = ops[i].op;
      return 0;
    }
  return -1;
}

// "<action> <syscall> [<index>,<op>,<value>,<valueTwo>]..."
static int add_seccomp_rule(struct policy *p, char *line, char *err, size_t errlen) {
  char *save = NULL;
  char *action_text = strtok_r(line, " ", &save);
  char *name = strtok_r(NULL, " ", &save);
  uint32_t action;
  if (!action_text || !name || parse_action(action_text, &action)) {
    snprintf(err, errlen, "bad seccomp rule");
    return -1;
  }
  struct scmp_arg_cmp args[6];
  unsigned nargs = 0;
  for (char *a; (a = strtok_r(NULL, " ", &save));) {
    char op[16];
    unsigned idx;
    unsigned long long v1, v2;
    int used = 0;
    if (nargs == 6 || sscanf(a, "%u,%15[A-Z_],%llu,%llu%n", &idx, op, &v1, &v2, &used) != 4 || a[used] || idx > 5) {
      snprintf(err, errlen, "bad seccomp argument for %s", name);
      return -1;
    }
    for (unsigned i = 0; i < nargs; i++)
      if (args[i].arg == idx) {
        snprintf(err, errlen, "repeated seccomp argument index for %s", name);
        return -1;
      }
    args[nargs].arg = idx;
    if (parse_op(op, &args[nargs].op)) {
      snprintf(err, errlen, "bad seccomp operator %s", op);
      return -1;
    }
    args[nargs].datum_a = v1;
    args[nargs].datum_b = v2;
    nargs++;
  }
  int nr = seccomp_syscall_resolve_name(name);
  // Like runc: names this libseccomp does not know are skipped.
  if (nr == __NR_SCMP_ERROR) return 0;
  int rc = seccomp_rule_add_array(p->seccomp, action, nr, nargs, args);
  // libseccomp refuses a rule whose action equals the default; runc skips it too.
  if (rc == -EACCES) return 0;
  if (rc < 0) {
    snprintf(err, errlen, "seccomp rule %s: %s", name, strerror(-rc));
    return -1;
  }
  return 0;
}

static int parse_tmpfs(struct tmpfs_mount *m, const char *spec) {
  const char *colon = strchr(spec, ':');
  size_t plen = colon ? (size_t)(colon - spec) : strlen(spec);
  if (!plen || plen >= sizeof m->path || spec[0] != '/') return -1;
  memcpy(m->path, spec, plen);
  m->path[plen] = 0;
  m->flags = MS_NOSUID | MS_NODEV | MS_NOEXEC;
  m->data[0] = 0;
  if (!colon) return 0;
  char opts[256];
  if (strlen(colon + 1) >= sizeof opts) return -1;
  strcpy(opts, colon + 1);
  char *save = NULL;
  for (char *o = strtok_r(opts, ",", &save); o; o = strtok_r(NULL, ",", &save)) {
    if (!strcmp(o, "rw")) m->flags &= ~MS_RDONLY;
    else if (!strcmp(o, "ro")) m->flags |= MS_RDONLY;
    else if (!strcmp(o, "noexec")) m->flags |= MS_NOEXEC;
    else if (!strcmp(o, "exec")) m->flags &= ~MS_NOEXEC;
    else if (!strcmp(o, "nosuid")) m->flags |= MS_NOSUID;
    else if (!strcmp(o, "suid")) m->flags &= ~MS_NOSUID;
    else if (!strcmp(o, "nodev")) m->flags |= MS_NODEV;
    else if (!strcmp(o, "dev")) m->flags &= ~MS_NODEV;
    else if (!strncmp(o, "size=", 5) || !strncmp(o, "mode=", 5)) {
      size_t used = strlen(m->data);
      if (used + strlen(o) + 2 > sizeof m->data) return -1;
      if (used) strcat(m->data, ",");
      strcat(m->data, o);
    } else return -1;
  }
  return 0;
}

static void env_set(struct policy *p, const char *kv) {
  size_t klen = strcspn(kv, "=");
  for (size_t i = 0; i < p->nenv; i++)
    if (!strncmp(p->env[i], kv, klen) && p->env[i][klen] == '=') {
      p->env[i] = strdup(kv);
      return;
    }
  p->env = realloc(p->env, (p->nenv + 2) * sizeof *p->env);
  if (!p->env) die("realloc");
  p->env[p->nenv++] = strdup(kv);
  p->env[p->nenv] = NULL;
}

// Copies a policy string, refusing (never truncating) one that does not fit.
static int set_text(char *dst, size_t size, const char *val) {
  if (strlen(val) >= size) return 1;
  strcpy(dst, val);
  return 0;
}

static long long parse_ll(const char *text, int *bad) {
  char *end;
  errno = 0;
  long long v = strtoll(text, &end, 10);
  if (errno || *end || v < 0) *bad = 1;
  return v;
}

// Fields are NUL-separated key=value pairs. Unknown keys fail closed.
static struct policy *parse_policy(const char *payload, size_t len, char *err, size_t errlen) {
  struct policy *p = calloc(1, sizeof *p);
  if (!p) die("calloc");
  p->raw = malloc(len + 1);
  if (!p->raw) die("malloc");
  memcpy(p->raw, payload, len);
  p->raw[len] = 0;
  p->rawlen = len;
  p->env = calloc(base_nenv + 1, sizeof *p->env);
  memcpy(p->env, base_env, base_nenv * sizeof *p->env);
  p->nenv = base_nenv;
  p->memory = p->swap = p->pids = p->rootfs = -1;

  char *copy = malloc(len + 1);
  memcpy(copy, payload, len);
  copy[len] = 0;
  int bad = 0;
  for (size_t at = 0; at < len && !bad;) {
    char *field = copy + at;
    size_t flen = strlen(field);
    at += flen + 1;
    if (!flen) continue;
    char *eq = strchr(field, '=');
    if (!eq) {
      snprintf(err, errlen, "field without '='");
      bad = 1;
      break;
    }
    *eq = 0;
    const char *key = field, *val = eq + 1;
    if (!strcmp(key, "hostname")) bad = set_text(p->hostname, sizeof p->hostname, val);
    else if (!strcmp(key, "user")) bad = set_text(p->user, sizeof p->user, val);
    else if (!strcmp(key, "cwd")) bad = set_text(p->cwd, sizeof p->cwd, val);
    else if (!strcmp(key, "env")) env_set(p, val);
    else if (!strcmp(key, "memory")) p->memory = parse_ll(val, &bad);
    else if (!strcmp(key, "swap")) p->swap = parse_ll(val, &bad);
    else if (!strcmp(key, "pids")) p->pids = parse_ll(val, &bad);
    else if (!strcmp(key, "rootfs")) p->rootfs = parse_ll(val, &bad);
    else if (!strcmp(key, "cpu")) bad = set_text(p->cpu, sizeof p->cpu, val);
    else if (!strcmp(key, "cap")) {
      int c = cap_number(val);
      if (c < 0) {
        snprintf(err, errlen, "unknown capability %s", val);
        bad = 1;
      } else p->keep_caps |= 1ull << c;
    } else if (!strcmp(key, "tmpfs")) {
      if (p->ntmpfs == 8 || parse_tmpfs(&p->tmpfs[p->ntmpfs++], val)) {
        snprintf(err, errlen, "bad tmpfs %s", val);
        bad = 1;
      }
    } else if (!strcmp(key, "seccomp-default")) {
      uint32_t action;
      if (p->seccomp || parse_action(val, &action) || !(p->seccomp = seccomp_init(action))) {
        snprintf(err, errlen, "bad seccomp default");
        bad = 1;
      } else if (seccomp_attr_set(p->seccomp, SCMP_FLTATR_CTL_NNP, 0)) {
        // The sudo demo needs setuid to work, so no_new_privs stays off.
        snprintf(err, errlen, "cannot clear seccomp no_new_privs");
        bad = 1;
      }
    } else if (!strcmp(key, "seccomp-arch")) {
      uint32_t arch = seccomp_arch_resolve_name(val);
      int rc = p->seccomp && arch ? seccomp_arch_add(p->seccomp, arch) : -EINVAL;
      if (rc < 0 && rc != -EEXIST) {
        snprintf(err, errlen, "bad seccomp arch %s", val);
        bad = 1;
      }
    } else if (!strcmp(key, "seccomp")) {
      if (!p->seccomp) {
        snprintf(err, errlen, "seccomp rule before default");
        bad = 1;
      } else {
        char line[512];
        if (strlen(val) >= sizeof line) {
          snprintf(err, errlen, "seccomp rule too long");
          bad = 1;
        } else {
          strcpy(line, val);
          if (add_seccomp_rule(p, line, err, errlen)) bad = 1;
        }
      }
    } else {
      snprintf(err, errlen, "unknown policy field %s", key);
      bad = 1;
    }
    if (bad && !err[0]) snprintf(err, errlen, "bad value for %s", key);
  }
  free(copy);
  if (!bad) {
    if (!p->hostname[0] || !p->user[0] || !p->cwd[0] || p->memory < 0 || p->swap < 0 || p->pids < 0
        || p->rootfs <= 0 || !p->cpu[0] || !p->seccomp) {
      snprintf(err, errlen, "policy is missing a required field");
      bad = 1;
    }
  }
  if (!bad) {
    struct passwd *pw = getpwnam(p->user);
    if (!pw) {
      snprintf(err, errlen, "unknown user %s", p->user);
      bad = 1;
    } else {
      p->uid = pw->pw_uid;
      p->gid = pw->pw_gid;
      p->ngroups = 64;
      if (getgrouplist(p->user, p->gid, p->groups, &p->ngroups) < 0) {
        snprintf(err, errlen, "too many groups for %s", p->user);
        bad = 1;
      }
    }
  }
  if (bad) {
    if (p->seccomp) seccomp_release(p->seccomp);
    free(p->raw);
    free(p);
    return NULL;
  }
  return p;
}

static struct policy *policy_for(const char *payload, size_t len, char *err, size_t errlen) {
  if (cached && cached->rawlen == len && !memcmp(cached->raw, payload, len)) return cached;
  struct policy *p = parse_policy(payload, len, err, errlen);
  // The previous policy is kept alive: a child cloned from it may still be
  // reading its copy, and in practice the backend sends one policy forever.
  if (p) cached = p;
  return p;
}

/* ---------- child: build the sandbox and exec the shell ---------- */

static void child_fail(const char *what) {
  char msg[512];
  int n = snprintf(msg, sizeof msg, "%s: %s", what, strerror(errno));
  send(3, msg, (size_t)n, MSG_NOSIGNAL);
  _exit(127);
}

#define CHK(expr, what) \
  do { \
    if ((expr) < 0) child_fail(what); \
  } while (0)

static const char *in_root(const char *path) {
  static char buf[4][PATH_MAX];
  static int i;
  i = (i + 1) % 4;
  snprintf(buf[i], sizeof buf[i], NEWROOT "%s", path);
  return buf[i];
}

static int exists(const char *path) {
  struct stat st;
  return lstat(path, &st) == 0;
}

static int ensure_file(const char *path) {
  if (exists(path)) return 0;
  int fd = open(path, O_CREAT | O_WRONLY | O_CLOEXEC, 0644);
  if (fd < 0) return -1;
  close(fd);
  return 0;
}

static int ensure_dir(const char *path, mode_t mode) {
  if (mkdir(path, mode) == 0 || errno == EEXIST) return 0;
  return -1;
}

static int loopback_up(void) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  struct ifreq ifr;
  memset(&ifr, 0, sizeof ifr);
  strcpy(ifr.ifr_name, "lo");
  int rc = ioctl(fd, SIOCGIFFLAGS, &ifr);
  if (rc == 0) {
    ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
    rc = ioctl(fd, SIOCSIFFLAGS, &ifr);
  }
  int saved = errno;
  close(fd);
  errno = saved;
  return rc;
}

static int bind_readonly(const char *src, const char *dst, unsigned long extra) {
  if (mount(src, dst, NULL, MS_BIND | MS_REC, NULL) < 0) return -1;
  return mount(NULL, dst, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | extra, NULL);
}

// Docker 29's default masked and read-only paths, in its order.
static const char *const READONLY_PATHS[] = {
  "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger",
};
static const char *const MASKED_PATHS[] = {
  "/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys",
  "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list",
  "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware",
};

static void build_root(const struct policy *p, int *master, int *slave) {
  char data[128];
  snprintf(data, sizeof data, "size=%lld,mode=755", p->rootfs);
  CHK(mount("tmpfs", STAGE, "tmpfs", MS_NOSUID | MS_NODEV, data), "stage tmpfs");
  CHK(mkdir(STAGE "/upper", 0755), "upper dir");
  CHK(mkdir(STAGE "/work", 0755), "work dir");
  CHK(mkdir(NEWROOT, 0755), "root dir");
  CHK(mount("overlay", NEWROOT, "overlay", 0,
            "lowerdir=/,upperdir=" STAGE "/upper,workdir=" STAGE "/work,xino=off"),
      "rootfs overlay");

  CHK(mount("proc", in_root("/proc"), "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL), "proc");
  CHK(mount("tmpfs", in_root("/dev"), "tmpfs", MS_NOSUID | MS_STRICTATIME, "size=65536k,mode=755"), "dev");
  CHK(mkdir(in_root("/dev/pts"), 0755), "dev/pts dir");
  CHK(mount("devpts", in_root("/dev/pts"), "devpts", MS_NOSUID | MS_NOEXEC,
            "newinstance,ptmxmode=0666,mode=0620,gid=5"),
      "devpts");
  CHK(mount("sysfs", in_root("/sys"), "sysfs", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL), "sysfs");
  CHK(mount("cgroup", in_root("/sys/fs/cgroup"), "cgroup2", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL),
      "cgroup2");
  CHK(mkdir(in_root("/dev/mqueue"), 0755), "mqueue dir");
  CHK(mount("mqueue", in_root("/dev/mqueue"), "mqueue", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL), "mqueue");
  CHK(mkdir(in_root("/dev/shm"), 0755), "shm dir");
  CHK(mount("shm", in_root("/dev/shm"), "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=65536k"), "shm");
  for (int i = 0; i < p->ntmpfs; i++) {
    CHK(ensure_dir(in_root(p->tmpfs[i].path), 0755), "tmpfs dir");
    CHK(mount("tmpfs", in_root(p->tmpfs[i].path), "tmpfs", p->tmpfs[i].flags, p->tmpfs[i].data), "tmpfs");
  }
  // The cell's Docker-written files, read-only: every visitor in the cell shares them.
  static const char *const etc_files[] = {"/etc/resolv.conf", "/etc/hostname", "/etc/hosts"};
  for (size_t i = 0; i < 3; i++) {
    CHK(ensure_file(in_root(etc_files[i])), "etc file");
    CHK(bind_readonly(etc_files[i], in_root(etc_files[i]), 0), "etc bind");
  }

  mode_t old = umask(0);
  static const struct { const char *name; unsigned maj, min; } nodes[] = {
    {"/dev/null", 1, 3}, {"/dev/zero", 1, 5}, {"/dev/full", 1, 7},
    {"/dev/random", 1, 8}, {"/dev/urandom", 1, 9}, {"/dev/tty", 5, 0},
  };
  for (size_t i = 0; i < sizeof nodes / sizeof *nodes; i++)
    CHK(mknod(in_root(nodes[i].name), S_IFCHR | 0666, makedev(nodes[i].maj, nodes[i].min)), "mknod");
  static const char *const links[][2] = {
    {"/proc/kcore", "/dev/core"}, {"/proc/self/fd", "/dev/fd"}, {"pts/ptmx", "/dev/ptmx"},
    {"/proc/self/fd/0", "/dev/stdin"}, {"/proc/self/fd/1", "/dev/stdout"}, {"/proc/self/fd/2", "/dev/stderr"},
  };
  for (size_t i = 0; i < sizeof links / sizeof *links; i++)
    CHK(symlink(links[i][0], in_root(links[i][1])), "dev symlink");

  *master = open(in_root("/dev/pts/ptmx"), O_RDWR | O_NOCTTY | O_CLOEXEC);
  CHK(*master, "open ptmx");
  int unlock = 0;
  CHK(ioctl(*master, TIOCSPTLCK, &unlock), "unlock pty");
  unsigned ptn;
  CHK(ioctl(*master, TIOCGPTN, &ptn), "pty number");
  *slave = ioctl(*master, TIOCGPTPEER, O_RDWR | O_NOCTTY);
  CHK(*slave, "open pty peer");
  CHK(fchmod(*slave, 0620), "chmod console");
  CHK(fchown(*slave, p->uid, 5), "chown console");
  char pts[64];
  snprintf(pts, sizeof pts, "/dev/pts/%u", ptn);
  CHK(ensure_file(in_root("/dev/console")), "console file");
  CHK(mount(in_root(pts), in_root("/dev/console"), NULL, MS_BIND, NULL), "console bind");
  umask(old);

  for (size_t i = 0; i < sizeof READONLY_PATHS / sizeof *READONLY_PATHS; i++) {
    const char *path = in_root(READONLY_PATHS[i]);
    if (!exists(path)) continue;
    CHK(bind_readonly(path, path, MS_NOSUID | MS_NODEV | MS_NOEXEC), "read-only path");
  }
  for (size_t i = 0; i < sizeof MASKED_PATHS / sizeof *MASKED_PATHS; i++) {
    const char *path = in_root(MASKED_PATHS[i]);
    struct stat st;
    if (lstat(path, &st) < 0) continue;
    if (S_ISDIR(st.st_mode)) CHK(mount("tmpfs", path, "tmpfs", MS_RDONLY, NULL), "mask dir");
    else CHK(mount(in_root("/dev/null"), path, NULL, MS_BIND, NULL), "mask file");
  }

  // The sockets and the writable cgroup tree stay out of this namespace, then
  // the new root covers the cell's.
  umount2("/run/cells", MNT_DETACH);
  CHK(umount2(CG_ROOT, MNT_DETACH), "detach cell cgroup");
  CHK(chdir(NEWROOT), "chdir new root");
  CHK(mount(NEWROOT, "/", NULL, MS_MOVE, NULL), "move root");
  CHK(chroot("."), "chroot");
  CHK(chdir("/"), "chdir /");
}

static int send_fds(int sock, int a, int b) {
  char byte = 'k';
  struct iovec iov = {.iov_base = &byte, .iov_len = 1};
  union {
    struct cmsghdr h;
    char space[CMSG_SPACE(2 * sizeof(int))];
  } u;
  memset(&u, 0, sizeof u);
  struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = u.space, .msg_controllen = sizeof u.space};
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
  c->cmsg_level = SOL_SOCKET;
  c->cmsg_type = SCM_RIGHTS;
  c->cmsg_len = CMSG_LEN(2 * sizeof(int));
  int fds[2] = {a, b};
  memcpy(CMSG_DATA(c), fds, sizeof fds);
  return sendmsg(sock, &msg, MSG_NOSIGNAL) < 0 ? -1 : 0;
}

static void __attribute__((noreturn)) child_main(const struct policy *p, const char *leaf, int setup) {
  if (setup != 3) {
    if (dup2(setup, 3) < 0) _exit(127);
  }
  syscall(SYS_close_range, 4, ~0u, 0);
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);

  char path[PATH_MAX];
  snprintf(path, sizeof path, CG_ROOT "/%s/cgroup.procs", leaf);
  CHK(write_file(path, "0"), "join cgroup");
  CHK(unshare(CLONE_NEWCGROUP), "cgroup namespace");
  CHK(sethostname(p->hostname, strlen(p->hostname)), "hostname");
  CHK(loopback_up(), "loopback");
  CHK(mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL), "private mounts");

  int master, slave;
  build_root(p, &master, &slave);
  int rootfd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  CHK(rootfd, "root fd");
  CHK(send_fds(3, master, rootfd), "send console");
  close(master);
  close(rootfd);
  close(3);

  if (setsid() < 0 || ioctl(slave, TIOCSCTTY, 0) < 0) _exit(127);
  if (dup2(slave, 0) < 0 || dup2(slave, 1) < 0 || dup2(slave, 2) < 0) _exit(127);
  if (slave > 2) close(slave);

  for (int r = 0; r < RLIM_NLIMITS; r++) setrlimit(r, &orig_rlimits[r]);
  umask(022);

  int rc = seccomp_load(p->seccomp);
  if (rc < 0) {
    dprintf(2, "cellsh: seccomp: %s\r\n", strerror(-rc));
    _exit(127);
  }
  for (int c = 0; c <= cap_last; c++)
    if (!(p->keep_caps & (1ull << c)) && prctl(PR_CAPBSET_DROP, c, 0, 0, 0) < 0) _exit(127);
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0) _exit(127);
  struct __user_cap_header_struct hdr = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct caps[2];
  if (syscall(SYS_capget, &hdr, caps) < 0) _exit(127);
  caps[0].inheritable = caps[1].inheritable = 0;
  if (syscall(SYS_capset, &hdr, caps) < 0) _exit(127);
  if (setgroups((size_t)p->ngroups, p->groups) < 0 || setresgid(p->gid, p->gid, p->gid) < 0
      || setresuid(p->uid, p->uid, p->uid) < 0)
    _exit(127);
  if (chdir(p->cwd) < 0) _exit(127);
  execve(shell_argv[0], shell_argv, p->env);
  dprintf(2, "cellsh: exec %s: %s\r\n", shell_argv[0], strerror(errno));
  _exit(127);
}

/* ---------- agent: sessions and relay ---------- */

static void ep_set(int fd, struct ep *e, uint32_t *current, uint32_t want) {
  if (fd < 0 || *current == want) return;
  struct epoll_event ev = {.events = want, .data.ptr = e};
  if (epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev) < 0) die("epoll_ctl mod");
  *current = want;
}

static void update_events(struct sess *s) {
  if (s->conn >= 0)
    ep_set(s->conn, &s->e_conn, &s->conn_events,
           (s->conn_paused || s->closing ? 0 : EPOLLIN) | (s->to_conn.len ? EPOLLOUT : 0));
  if (s->master >= 0)
    ep_set(s->master, &s->e_master, &s->master_events,
           (s->throttled ? 0 : EPOLLIN) | (s->to_master.len ? EPOLLOUT : 0));
}

static void ep_add(int fd, struct ep *e, uint32_t events) {
  struct epoll_event ev = {.events = events, .data.ptr = e};
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev) < 0) die("epoll_ctl add");
}

static void close_fd(int *fd) {
  if (*fd >= 0) {
    epoll_ctl(epfd, EPOLL_CTL_DEL, *fd, NULL);
    close(*fd);
    *fd = -1;
  }
}

static void maybe_free(struct sess *s) {
  if (s->conn >= 0 || s->setup >= 0 || (s->pid > 0 && !s->reaped)) return;
  close_fd(&s->master);
  close_fd(&s->root);
  for (struct sess **pp = &sessions; *pp; pp = &(*pp)->next)
    if (*pp == s) {
      *pp = s->next;
      s->next = dead;
      dead = s;
      break;
    }
}

static void free_dead(void) {
  while (dead) {
    struct sess *s = dead;
    dead = s->next;
    buf_free(&s->in);
    buf_free(&s->to_conn);
    buf_free(&s->to_master);
    free(s);
  }
}

static int leaf_oom_kills(const struct sess *s) {
  char path[PATH_MAX], events[512];
  snprintf(path, sizeof path, CG_ROOT "/%s/memory.events", s->leaf);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = read(fd, events, sizeof events - 1);
  close(fd);
  events[n > 0 ? n : 0] = 0;
  const char *k = strstr(events, "oom_kill ");
  return k ? atoi(k + 9) : 0;
}

static void kill_leaf(struct sess *s) {
  if (s->pid > 0 && !s->reaped && write_leaf(s->leaf, "cgroup.kill", "1") < 0)
    logf_("kill %s: %s", s->leaf, strerror(errno));
}

static void drop_conn(struct sess *s) {
  close_fd(&s->conn);
  buf_free(&s->in);
  buf_free(&s->to_conn);
  kill_leaf(s);
  close_fd(&s->setup);
  maybe_free(s);
}

static void flush_conn(struct sess *s) {
  while (s->to_conn.len) {
    ssize_t n = send(s->conn, s->to_conn.p + s->to_conn.off, s->to_conn.len, MSG_NOSIGNAL);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) break;
      drop_conn(s);
      return;
    }
    buf_drop(&s->to_conn, (size_t)n);
  }
  if (s->throttled && s->to_conn.len < LOW_WATER) s->throttled = 0;
  if (s->closing && !s->to_conn.len) {
    drop_conn(s);
    return;
  }
  update_events(s);
}

static void send_frame(struct sess *s, char type, const void *data, size_t len) {
  if (s->conn < 0) return;
  char h[HDR];
  put_header(h, type, (uint32_t)len);
  if (!s->to_conn.len) {
    struct iovec iov[2] = {{h, HDR}, {(void *)data, len}};
    ssize_t n = writev(s->conn, iov, 2);
    if (n < 0 && errno != EAGAIN && errno != EINTR) {
      drop_conn(s);
      return;
    }
    size_t sent = n < 0 ? 0 : (size_t)n;
    if (sent == HDR + len) return;
    if (sent < HDR) {
      buf_put(&s->to_conn, h + sent, HDR - sent);
      buf_put(&s->to_conn, data, len);
    } else buf_put(&s->to_conn, (const char *)data + (sent - HDR), len - (sent - HDR));
  } else {
    buf_put(&s->to_conn, h, HDR);
    buf_put(&s->to_conn, data, len);
  }
  if (s->to_conn.len > HIGH_WATER) s->throttled = 1;
  update_events(s);
}

static void send_text(struct sess *s, char type, const char *text) {
  send_frame(s, type, text, strlen(text));
}

static void fail_session(struct sess *s, const char *msg) {
  send_text(s, 'E', msg);
  if (s->conn >= 0) {
    s->closing = 1;
    flush_conn(s);
  }
}

static void apply_size(struct sess *s) {
  if (s->master < 0 || !s->have_size) return;
  struct winsize ws = {.ws_row = s->rows, .ws_col = s->cols};
  ioctl(s->master, TIOCSWINSZ, &ws);
}

static void spawn(struct sess *s, const char *payload, size_t len) {
  char err[256] = "";
  if (s->pid || s->setup >= 0) {
    fail_session(s, "spawn sent twice");
    return;
  }
  const struct policy *p = policy_for(payload, len, err, sizeof err);
  if (!p) {
    fail_session(s, err);
    return;
  }
  snprintf(s->leaf, sizeof s->leaf, "s%u", s->id);
  char dir[PATH_MAX], value[64];
  snprintf(dir, sizeof dir, CG_ROOT "/%s", s->leaf);
  if (mkdir(dir, 0755) < 0) {
    snprintf(err, sizeof err, "create cgroup: %s", strerror(errno));
    fail_session(s, err);
    return;
  }
  int bad = 0;
  snprintf(value, sizeof value, "%lld", p->memory);
  bad |= write_leaf(s->leaf, "memory.max", value);
  snprintf(value, sizeof value, "%lld", p->swap);
  bad |= write_leaf(s->leaf, "memory.swap.max", value);
  snprintf(value, sizeof value, "%lld", p->pids);
  bad |= write_leaf(s->leaf, "pids.max", value);
  bad |= write_leaf(s->leaf, "cpu.max", p->cpu);
  int sp[2] = {-1, -1};
  if (bad || socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sp) < 0) {
    snprintf(err, sizeof err, "cgroup limits: %s", strerror(errno));
    rmdir(dir);
    fail_session(s, err);
    return;
  }
  long pid = syscall(SYS_clone, CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | SIGCHLD,
                     NULL, NULL, NULL, 0);
  if (pid == 0) {
    close(sp[0]);
    child_main(p, s->leaf, sp[1]);
  }
  close(sp[1]);
  if (pid < 0) {
    snprintf(err, sizeof err, "clone: %s", strerror(errno));
    close(sp[0]);
    rmdir(dir);
    fail_session(s, err);
    return;
  }
  s->pid = (pid_t)pid;
  s->setup = sp[0];
  fcntl(s->setup, F_SETFL, O_NONBLOCK);
  ep_add(s->setup, &s->e_setup, EPOLLIN);
}

static void on_setup(struct sess *s) {
  char data[512];
  int fds[2] = {-1, -1};
  union {
    struct cmsghdr h;
    char space[CMSG_SPACE(2 * sizeof(int))];
  } u;
  struct iovec iov = {.iov_base = data, .iov_len = sizeof data - 1};
  struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = u.space, .msg_controllen = sizeof u.space};
  ssize_t n = recvmsg(s->setup, &msg, MSG_CMSG_CLOEXEC);
  if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c))
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len == CMSG_LEN(2 * sizeof(int)))
      memcpy(fds, CMSG_DATA(c), sizeof fds);
  close_fd(&s->setup);
  if (fds[0] < 0 || fds[1] < 0) {
    if (fds[0] >= 0) close(fds[0]);
    if (fds[1] >= 0) close(fds[1]);
    data[n > 0 ? n : 0] = 0;
    char err[600];
    snprintf(err, sizeof err, "sandbox setup failed: %s", n > 0 ? data : "child exited");
    logf_("%s %s", s->leaf, err);
    kill_leaf(s);
    fail_session(s, err);
    maybe_free(s);
    return;
  }
  if (s->reaped) {
    // The child handed over its console and then died before exec; reap()
    // left the connection to this handler.
    close(fds[0]);
    close(fds[1]);
    fail_session(s, "sandbox exited during setup");
    maybe_free(s);
    return;
  }
  s->master = fds[0];
  s->root = fds[1];
  fcntl(s->master, F_SETFL, O_NONBLOCK);
  s->master_events = EPOLLIN;
  ep_add(s->master, &s->e_master, EPOLLIN);
  apply_size(s);
  if (s->conn < 0) {
    kill_leaf(s);
    maybe_free(s);
    return;
  }
  send_text(s, 'K', s->leaf);
  flush_master(s);
}

static void flush_master(struct sess *s) {
  while (s->master >= 0 && s->to_master.len) {
    ssize_t n = write(s->master, s->to_master.p + s->to_master.off, s->to_master.len);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno != EAGAIN) buf_free(&s->to_master);
      break;
    }
    buf_drop(&s->to_master, (size_t)n);
  }
  if (s->conn_paused && s->to_master.len < LOW_WATER) s->conn_paused = 0;
  update_events(s);
}

static void on_frame(struct sess *s, char type, const char *p, uint32_t len) {
  switch (type) {
  case 'S':
    spawn(s, p, len);
    break;
  case 'I':
    if (s->master < 0 && s->setup < 0) break;
    buf_put(&s->to_master, p, len);
    if (s->to_master.len > HIGH_WATER) s->conn_paused = 1;
    flush_master(s);
    break;
  case 'R': {
    char text[32];
    unsigned cols, rows;
    if (len >= sizeof text) break;
    memcpy(text, p, len);
    text[len] = 0;
    if (sscanf(text, "%u %u", &cols, &rows) != 2 || !cols || !rows || cols > 65535 || rows > 65535) break;
    s->cols = (unsigned short)cols;
    s->rows = (unsigned short)rows;
    s->have_size = 1;
    apply_size(s);
    break;
  }
  case 'U': {
    struct statfs st;
    char text[64];
    if (s->root < 0 || fstatfs(s->root, &st) < 0) {
      send_text(s, 'U', "-1 0");
      break;
    }
    snprintf(text, sizeof text, "%llu %d",
             (unsigned long long)(st.f_blocks - st.f_bfree) * (unsigned long long)st.f_bsize, leaf_oom_kills(s));
    send_text(s, 'U', text);
    break;
  }
  default:
    drop_conn(s);
  }
}

static void on_conn(struct sess *s, uint32_t events) {
  if (events & EPOLLOUT) {
    flush_conn(s);
    if (s->conn < 0) return;
  }
  if (!(events & (EPOLLIN | EPOLLHUP | EPOLLERR))) return;
  buf_reserve(&s->in, READ_CHUNK);
  ssize_t n = read(s->conn, s->in.p + s->in.off + s->in.len, READ_CHUNK);
  if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
  if (n <= 0) {
    drop_conn(s);
    return;
  }
  s->in.len += (size_t)n;
  while (s->conn >= 0 && s->in.len >= HDR) {
    const unsigned char *h = (const unsigned char *)s->in.p + s->in.off;
    uint32_t len = (uint32_t)h[1] << 24 | (uint32_t)h[2] << 16 | (uint32_t)h[3] << 8 | h[4];
    if (len > MAX_FRAME) {
      drop_conn(s);
      return;
    }
    if (s->in.len < HDR + len) break;
    char type = (char)h[0];
    on_frame(s, type, s->in.p + s->in.off + HDR, len);
    if (s->conn >= 0) buf_drop(&s->in, HDR + len);
  }
}

static void master_eof(struct sess *s) {
  close_fd(&s->master);
  buf_free(&s->to_master);
}

static int read_master(struct sess *s) {
  char data[HDR + READ_CHUNK];
  ssize_t n = read(s->master, data + HDR, READ_CHUNK);
  if (n > 0) {
    send_frame(s, 'O', data + HDR, (size_t)n);
    return 1;
  }
  if (n < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
  master_eof(s);
  return 0;
}

static void on_master(struct sess *s, uint32_t events) {
  if (events & EPOLLOUT) flush_master(s);
  if (s->master < 0) return;
  if (events & (EPOLLHUP | EPOLLERR)) {
    // The slave side is gone: drain whatever is buffered regardless of throttling.
    while (s->master >= 0 && read_master(s)) {
    }
    if (s->master >= 0) master_eof(s);
    return;
  }
  if (events & EPOLLIN) read_master(s);
}

static void reap(void) {
  int status;
  pid_t pid;
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    struct sess *s = sessions;
    while (s && s->pid != pid) s = s->next;
    if (!s) continue;
    s->reaped = 1;
    s->status = status;
    while (s->master >= 0 && read_master(s)) {
    }
    char path[PATH_MAX];
    s->oom_kills = leaf_oom_kills(s);
    snprintf(path, sizeof path, CG_ROOT "/%s", s->leaf);
    if (rmdir(path) < 0) logf_("rmdir %s: %s", s->leaf, strerror(errno));
    if (s->conn >= 0 && !s->closing && s->setup < 0) {
      char text[64];
      snprintf(text, sizeof text, "%d %d", status, s->oom_kills);
      send_text(s, 'X', text);
      if (s->conn >= 0) {
        s->closing = 1;
        flush_conn(s);
      }
    } else if (s->oom_kills) {
      logf_("%s ended after the backend left: oom_kill %d", s->leaf, s->oom_kills);
    }
    maybe_free(s);
  }
}

static void on_listen(int lfd) {
  for (;;) {
    int fd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (fd < 0) return;
    struct sess *s = calloc(1, sizeof *s);
    if (!s) die("calloc");
    s->id = ++next_id;
    s->conn = fd;
    s->master = s->root = s->setup = -1;
    s->e_conn = (struct ep){K_CONN, s};
    s->e_master = (struct ep){K_MASTER, s};
    s->e_setup = (struct ep){K_SETUP, s};
    s->conn_events = EPOLLIN;
    s->next = sessions;
    sessions = s;
    ep_add(fd, &s->e_conn, EPOLLIN);
  }
}

static void setup_cgroups(void) {
  if (ensure_dir(CELL_DIR, 0700) < 0 || ensure_dir(CG_ROOT, 0700) < 0 || ensure_dir(STAGE, 0700) < 0)
    die("mkdir " CELL_DIR);
  if (mount("cgroup2", CG_ROOT, "cgroup2", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) < 0) die("mount cgroup2");
  if (ensure_dir(CG_ROOT "/agent", 0755) < 0) die("mkdir agent cgroup");
  if (write_file(CG_ROOT "/agent/cgroup.procs", "0") < 0) die("join agent cgroup");
  if (write_file(CG_ROOT "/cgroup.subtree_control", "+cpu +memory +pids") < 0) die("enable controllers");
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: cellsh SOCKET COMMAND [ARG...]\n");
    return 2;
  }
  const char *sock_path = argv[1];
  shell_argv = argv + 2;
  extern char **environ;
  base_env = environ;
  while (base_env[base_nenv]) base_nenv++;

  for (int r = 0; r < RLIM_NLIMITS; r++) getrlimit(r, &orig_rlimits[r]);
  struct rlimit nofile = orig_rlimits[RLIMIT_NOFILE];
  nofile.rlim_cur = nofile.rlim_max;
  setrlimit(RLIMIT_NOFILE, &nofile);
  FILE *f = fopen("/proc/sys/kernel/cap_last_cap", "re");
  if (!f || fscanf(f, "%d", &cap_last) != 1) die("cap_last_cap");
  fclose(f);
  prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);

  sigset_t mask;
  sigemptyset(&mask);
  sigaddset(&mask, SIGCHLD);
  sigaddset(&mask, SIGTERM);
  sigaddset(&mask, SIGINT);
  sigaddset(&mask, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &mask, NULL) < 0) die("sigprocmask");
  int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
  if (sfd < 0) die("signalfd");

  setup_cgroups();

  int lfd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (lfd < 0) die("socket");
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  if (strlen(sock_path) >= sizeof addr.sun_path) {
    errno = ENAMETOOLONG;
    die("socket path");
  }
  strcpy(addr.sun_path, sock_path);
  unlink(sock_path);
  if (bind(lfd, (struct sockaddr *)&addr, sizeof addr) < 0) die("bind");
  if (chmod(sock_path, 0600) < 0) die("chmod socket");
  if (listen(lfd, 256) < 0) die("listen");

  epfd = epoll_create1(EPOLL_CLOEXEC);
  if (epfd < 0) die("epoll_create1");
  struct ep e_listen = {K_LISTEN, NULL}, e_signal = {K_SIGNAL, NULL};
  ep_add(lfd, &e_listen, EPOLLIN);
  ep_add(sfd, &e_signal, EPOLLIN);
  logf_("listening on %s", sock_path);

  struct epoll_event events[64];
  for (;;) {
    int n = epoll_wait(epfd, events, 64, -1);
    if (n < 0) {
      if (errno == EINTR) continue;
      die("epoll_wait");
    }
    for (int i = 0; i < n; i++) {
      struct ep *e = events[i].data.ptr;
      uint32_t ev = events[i].events;
      switch (e->kind) {
      case K_LISTEN:
        on_listen(lfd);
        break;
      case K_SIGNAL: {
        struct signalfd_siginfo si;
        int stop = 0;
        while (read(sfd, &si, sizeof si) == sizeof si)
          if (si.ssi_signo != SIGCHLD) stop = 1;
        reap();
        if (stop) {
          for (struct sess *s = sessions; s; s = s->next) kill_leaf(s);
          unlink(sock_path);
          return 0;
        }
        break;
      }
      case K_CONN:
        if (e->s->conn >= 0) on_conn(e->s, ev);
        break;
      case K_MASTER:
        if (e->s->master >= 0) on_master(e->s, ev);
        break;
      case K_SETUP:
        if (e->s->setup >= 0) on_setup(e->s);
        break;
      }
    }
    free_dead();
  }
}
