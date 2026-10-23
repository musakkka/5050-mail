#!/usr/bin/env python3
"""Run a command in a pseudo-terminal and answer its prompts. Test use only.

  pty_drive.py OUTFILE [--timeout N] [--step 'REGEX::TEXT' ...] -- command args...

Each --step waits until REGEX shows up in the output produced since the previous step, then types
TEXT and Enter (TEXT may be empty or @env:NAME to read it from the environment; a trailing '^' sends the text without Enter). Steps run in order.
The full output is written to OUTFILE. Exit status: the command's, or 99 when a step timed out.
"""
import os
import pty
import re
import select
import sys
import time


ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def main():
    args = sys.argv[1:]
    out = args.pop(0)
    timeout, steps = 90, []
    while args and args[0] != "--":
        a = args.pop(0)
        if a == "--timeout":
            timeout = int(args.pop(0))
        elif a == "--step":
            rx, _, text = args.pop(0).partition("::")
            if text.startswith("@env:"):  # take the text from an environment variable (secrets stay off the command line)
                text = os.environ[text[5:]]
            steps.append((re.compile(rx), text))
    cmd = args[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    try:  # a real terminal size, so ssh and spinners behave
        import fcntl, struct, termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
    except Exception:
        pass
    buf, mark, status, deadline = b"", 0, None, time.time() + timeout
    log = open(out, "wb")
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                data = b""
            if not data:
                break
            buf += data
            log.write(data)
            log.flush()
        if steps:
            rx, text = steps[0]
            plain = ANSI.sub("", buf.decode("utf-8", "replace"))
            m = rx.search(plain[mark:])
            if m:
                mark = len(plain)
                steps.pop(0)
                time.sleep(0.15)
                os.write(fd, (text[:-1] if text.endswith("^") else text + "\r").encode())
    else:
        os.kill(pid, 9)
        log.write(b"\n[pty_drive: timeout]\n")
        status = 99
    _, st = os.waitpid(pid, 0)
    log.close()
    if status is None:
        status = os.waitstatus_to_exitcode(st)
    if steps and status == 0:
        print(f"pty_drive: unmatched step: {steps[0][0].pattern}", file=sys.stderr)
        status = 98
    sys.exit(status)


main()
