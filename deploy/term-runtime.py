#!/usr/bin/env python3
"""Select the measured crun runtime without replacing other Docker settings."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/docker/daemon.json'))
    parser.add_argument('--pid-file', type=Path, default=Path('/var/run/docker.pid'))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run the runtime installer as root.')
    crun = shutil.which('crun')
    if crun is None:
        raise SystemExit('Install crun before deployment. The measured candidate uses crun 1.28.')
    version = subprocess.check_output([crun, '--version'], text=True)
    release = re.fullmatch(r'crun version (\d+)\.(\d+)(?:\.\d+)?', version.splitlines()[0])
    if release is None or tuple(map(int, release.groups())) < (1, 28):
        raise SystemExit('Install crun 1.28 or newer before deployment.')
    if any(feature not in version for feature in ('+SECCOMP', '+CAP', '+APPARMOR')):
        raise SystemExit('crun must include SECCOMP, CAP, and APPARMOR support.')

    config = args.config.resolve()
    current = json.loads(config.read_text()) if config.exists() else {}
    if not isinstance(current, dict):
        raise SystemExit('Docker daemon.json must contain an object.')
    updated = json.loads(json.dumps(current))
    runtimes = updated.setdefault('runtimes', {})
    if not isinstance(runtimes, dict):
        raise SystemExit('Docker runtimes must contain an object.')
    runtime = {'path': crun}
    if 'crun' in runtimes and runtimes['crun'] != runtime:
        raise SystemExit('The existing crun registration differs. Resolve it before deployment.')
    runtimes['crun'] = runtime
    updated['default-runtime'] = 'crun'
    changed = updated != current
    docker_info = ['docker', '--host=unix:///var/run/docker.sock', 'info', '--format', '{{.DefaultRuntime}}']
    active = subprocess.check_output(docker_info, text=True).strip()
    reload_needed = changed or active != 'crun'
    if reload_needed:
        pid = int(args.pid_file.read_text().strip())
        if Path(f'/proc/{pid}/comm').read_text().strip() != 'dockerd':
            raise SystemExit('The Docker PID file does not identify dockerd.')

    config.parent.mkdir(parents=True, exist_ok=True)
    candidate = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=config.parent, prefix='.term-runtime-', suffix='.json', delete=False) as file:
            candidate = Path(file.name)
            json.dump(updated, file, indent=2)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        subprocess.run(['dockerd', '--validate', '--config-file', str(candidate)], check=True)
        if changed:
            if config.exists():
                previous = config.stat()
                candidate.chmod(stat.S_IMODE(previous.st_mode))
                os.chown(candidate, previous.st_uid, previous.st_gid)
            else:
                candidate.chmod(0o644)
            os.replace(candidate, config)
            candidate = None
    finally:
        if candidate is not None:
            candidate.unlink()

    if reload_needed:
        os.kill(pid, signal.SIGHUP)
        for _ in range(20):
            if subprocess.check_output(docker_info, text=True).strip() == 'crun':
                break
            time.sleep(0.5)
        else:
            raise SystemExit('Docker did not activate crun. The validated configuration remains installed.')
    print(f'Docker default runtime is crun at {crun}. Configuration {"updated" if changed else "unchanged"}.')
