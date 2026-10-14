#!/usr/bin/env python3
import argparse
import os
import pathlib
import pty
import select
import subprocess
import tempfile


def run(image, fixture, mode, delimiter):
    master, slave = pty.openpty()
    expected_status = 0 if mode == "natural" else 10 if mode == "skip" else 143
    name = f"cap-anim-player-{mode}-{delimiter}"
    playback = f"animation-playback {delimiter} 1000; status=$?"
    if mode == "signal":
        playback = (f"(printf '%s\\n' \"$BASHPID\" >/tmp/player-pid; "
                    f"exec animation-playback {delimiter} 1000) </dev/tty & player=$!; wait $player; status=$?")
    command = ["docker", "run", "--rm", "--name", name, "--network", "none",
               "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "-i", "-t",
               "-v", f"{fixture}:/check:ro", "--entrypoint", "bash", image, "-c",
               f"before=$(stty -g); exec 3</check/frames; {playback}; "
               f"after=$(stty -g); [[ $status == {expected_status} && $before == $after ]]"]
    proc = subprocess.Popen(command, stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.close(slave)
    try:
        first = b""
        while len(first) < 5:
            if not select.select([proc.stdout], [], [], 10)[0]:
                raise TimeoutError(f"{mode} did not emit its first frame")
            chunk = os.read(proc.stdout.fileno(), 5 - len(first))
            if not chunk:
                break
            first += chunk
        if first != b"first":
            raise AssertionError(f"{mode} did not emit its first frame: {first!r}")
        if mode == "skip":
            os.write(master, b"x")
        if mode == "signal":
            subprocess.run(["docker", "exec", name, "bash", "-c",
                            "read -r player </tmp/player-pid && kill -TERM \"$player\""], check=True)
        status = proc.wait(timeout=10)
        data = first + proc.stdout.read()
        error = proc.stderr.read()
        expected = b"firstsecond" if mode == "natural" else b"first"
        if status or data != expected or error:
            raise AssertionError(f"{mode}: status={status} output={data!r} stderr={error!r}")
        print(f"{mode} {delimiter}: exact frames, expected status, terminal modes restored", flush=True)
    finally:
        os.close(master)
        if proc.poll() is None:
            subprocess.run(["docker", "rm", "-f", name], check=False)
            proc.kill()
            proc.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cap-anim-player-") as directory:
        fixture = pathlib.Path(directory)
        fixture.chmod(0o755)
        for delimiter, separator in (("line", b"\n"), ("soh", b"\001")):
            (fixture / "frames").write_bytes(b"first" + separator + b"second" + separator)
            for mode in ("natural", "skip", "signal"):
                run(args.image, fixture, mode, delimiter)


if __name__ == "__main__":
    main()
