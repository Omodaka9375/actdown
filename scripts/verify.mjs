// Shell-agnostic verify: runs tsc, then vitest. Avoids "&&" so the command
// works under cmd.exe and PowerShell alike.
import { spawnSync } from "node:child_process";
import process from "node:process";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"]);
run("pnpm", ["exec", "vitest", "run"]);
