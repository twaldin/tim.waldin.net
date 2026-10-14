#!/usr/bin/env python3
import argparse
import os
from pathlib import Path
import shlex

parser = argparse.ArgumentParser()
parser.add_argument('--dind-dockerfile', required=True)
args, workload = parser.parse_known_args()
root = Path(__file__).resolve().parents[2]
runner = root / 'bench/capacity/run.sh'
variant = (root / args.dind_dockerfile).resolve()
source = runner.read_text()
replacements = {
    'P=capbench-$ID': 'P=cap-shimgc-$ID',
    '-f "$HERE/Dockerfile.dind"': '-f ' + shlex.quote(str(variant)),
}
for original, replacement in replacements.items():
    if source.count(original) != 1:
        raise SystemExit(f'frozen runner anchor changed: {original}')
    source = source.replace(original, replacement)
os.execvp('bash', ['bash', '-c', source, str(runner), *workload])
