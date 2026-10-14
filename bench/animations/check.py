#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
import statistics
import subprocess
import tempfile
import threading

ANIMATIONS = ("braille-fire", "braille-plasma", "starfield-warp", "logo-decode", "font-cycle")


def capture(image, animation, width, fixture, sample, skip=False):
    name = f"cap-anim-check-{animation}-{width}-{sample}"
    command = [
        "docker", "run", "--rm", "--name", name, "--network", "none",
        "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
        "--pids-limit", "128", "--memory", "512m", "-i",
        "-e", f"COLUMNS={width}", "-e", "LINES=45", "-e", "LC_ALL=C.UTF-8",
        "-v", f"{fixture}:/check:ro", "--entrypoint", "bash", image, "-c",
        "export BOOT_BANNER_FILE=/check/banner; "
        "TIMEFORMAT='ANIM_TIME %R %U %S'; "
        f"time bash -c 'RANDOM=7; source /check/{animation}.sh'",
    ]
    if (fixture / "fixed-random.so").exists():
        command[2:2] = ["-e", "LD_PRELOAD=/check/fixed-random.so"]
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if skip:
        proc.stdin.write(b"x")
        proc.stdin.flush()
    streams = {}

    def drain(key, stream):
        streams[key] = stream.read()

    readers = [threading.Thread(target=drain, args=(key, stream)) for key, stream in
               (("out", proc.stdout), ("err", proc.stderr))]
    for reader in readers:
        reader.start()
    try:
        status = proc.wait(timeout=180)
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "rm", "-f", name], check=False)
        proc.kill()
        raise
    finally:
        proc.stdin.close()
        for reader in readers:
            reader.join()
    if status:
        raise RuntimeError(streams["err"].decode(errors="replace"))
    timing = [line for line in streams["err"].decode().splitlines() if line.startswith("ANIM_TIME ")]
    if len(timing) != 1 or streams["err"].decode().strip() != timing[0]:
        raise RuntimeError(streams["err"].decode(errors="replace"))
    real, user, system = map(float, timing[0].split()[1:])
    return streams["out"], {"real_s": real, "user_s": user, "system_s": system, "cpu_s": user + system}


def main():
    parser = argparse.ArgumentParser(
        epilog="For deterministic parity, build the test-only interposer with "
               "cc -shared -fPIC -O2 bench/animations/fixed-random.c -o <library> and pass "
               "--fixed-random <library>. Omit it for real CPU measurements. "
               "Parity summaries contain no CPU metrics.",
    )
    parser.add_argument("images", nargs="+")
    parser.add_argument("--widths", default="40,80,160")
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--fixed-random", type=pathlib.Path)
    parser.add_argument("--skip", action="store_true", help="Queue one skip key before the first frame.")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    image_ids = {image: subprocess.check_output([
        "docker", "image", "inspect", "--format", "{{.Id}}", image,
    ]).decode().strip() for image in args.images}
    with tempfile.TemporaryDirectory(prefix="cap-anim-check-") as directory:
        fixture = pathlib.Path(directory)
        fixture.chmod(0o755)
        if args.fixed_random:
            (fixture / "fixed-random.so").write_bytes(args.fixed_random.read_bytes())
        for image in args.images:
            for animation in ANIMATIONS:
                code = subprocess.check_output([
                    "docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", image_ids[image],
                    f"/home/portfolio/scripts/animations/{animation}.sh",
                ]).decode()
                (fixture / f"{image.replace('/', '_').replace(':', '_')}-{animation}").write_text(code)
        for width in map(int, args.widths.split(",")):
            banner = subprocess.check_output([
                "docker", "run", "--rm", "--network", "none", "--entrypoint", "bash", image_ids[args.images[0]],
                "-c", "source /home/portfolio/scripts/shared-functions.sh; "
                f"font=$(RANDOM=7; pick_font_for_width {width - 2}); render_banner twaldin \"${{font##*|}}\"",
            ])
            if not banner:
                raise AssertionError(f"No production banner fits {width} columns")
            (fixture / "banner").write_bytes(banner)
            (args.output / f"banner-{width}.bin").write_bytes(banner)
            for animation in ANIMATIONS:
                reference = None
                samples = {image: [] for image in args.images}
                for sample in range(args.repeat):
                    for image in args.images:
                        code = (fixture / f"{image.replace('/', '_').replace(':', '_')}-{animation}").read_text()
                        (fixture / f"{animation}.sh").write_text(code)
                        data, timing = capture(image_ids[image], animation, width, fixture, sample, args.skip)
                        filename = f"{image.replace('/', '_').replace(':', '_')}-{animation}-{width}-{sample}"
                        (args.output / f"{filename}.bin").write_bytes(data)
                        record = {"image": image, "image_id": image_ids[image], "animation": animation,
                                  "width": width, "sample": sample, "bytes": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest(), "skip": args.skip}
                        if reference is None:
                            reference = data
                        if (args.fixed_random or animation in ("braille-plasma", "font-cycle")) and data != reference:
                            raise AssertionError(f"Output differs for {image} {animation} at {width} columns sample {sample}")
                        record["mode"] = "parity" if args.fixed_random else "cpu"
                        if not args.fixed_random:
                            record.update(timing)
                        samples[image].append(record)
                        print(json.dumps(record), flush=True)
                for image, times in samples.items():
                    if times:
                        summary = {"image": image, "image_id": image_ids[image], "animation": animation,
                                   "width": width, "mode": "parity" if args.fixed_random else "cpu",
                                   "skip": args.skip, "samples": times}
                        if not args.fixed_random:
                            summary.update({
                                "median_cpu_s": statistics.median(t["cpu_s"] for t in times),
                                "median_real_s": statistics.median(t["real_s"] for t in times),
                                "cpu_range_s": [min(t["cpu_s"] for t in times), max(t["cpu_s"] for t in times)],
                            })
                        results.append(summary)
    (args.output / "summary.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
