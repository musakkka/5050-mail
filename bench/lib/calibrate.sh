#!/usr/bin/env bash
# CPU availability check: SHA-256 (64 KiB blocks) per second on a cpuset, one thread per core, 3 s.
# Compare runs against each other: a much lower number means the host was busy during that run.
#   lib/calibrate.sh 0-1 2   ->  {"cpus":"0-1","threads":2,"hash_per_sec_total":...,"per_thread":...}
docker run --rm --cpuset-cpus="$1" -e N="$2" -e CPUS="$1" node:22-alpine node -e '
const { Worker } = require("node:worker_threads");
const n = Number(process.env.N);
const code = `const c=require("node:crypto");const b=Buffer.alloc(65536);let i=0;const t=Date.now();while(Date.now()-t<3000){c.createHash("sha256").update(b).digest();i++}require("node:worker_threads").parentPort.postMessage(i/3)`;
Promise.all(Array.from({ length: n }, () => new Promise((r) => new Worker(code, { eval: true }).on("message", r))))
  .then((v) => { const tot = v.reduce((a, b) => a + b, 0); console.log(JSON.stringify({ cpus: process.env.CPUS, threads: n, hash_per_sec_total: Math.round(tot), per_thread: Math.round(tot / n) })); });
'
