// Generate a fresh TARGET_TOKEN and set the same value on both Workers.
//
//   node tools/set-target-token.mjs
//
// The room Worker authorizes its calls to the target with this shared secret,
// so the two values have to match exactly. Piping it through a shell risks a
// trailing newline, which would end up inside an Authorization header and fail
// in a way that looks like a network fault - so the value is written straight
// to wrangler's stdin with no terminator, and never printed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// Call wrangler's entrypoint with this node binary. Going through npx would
// mean spawning npx.cmd on Windows, which modern Node refuses without a shell,
// and shell:true with arguments is itself deprecated.
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

// Resolve the Worker directories from this file, not from the shell's current
// directory, so the script behaves the same whether it runs from the repo root
// or from inside worker/.
const workerPath = (name) => fileURLToPath(new URL(`../${name}/`, import.meta.url));

function putSecret(cwd, name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, "secret", "put", name], {
      cwd,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler exited ${code} while setting ${name} in ${cwd}/`));
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

const token = randomBytes(32).toString("hex");

for (const name of ["target", "worker"]) {
  process.stdout.write(`setting TARGET_TOKEN in ${name}/ ...\n`);
  await putSecret(workerPath(name), "TARGET_TOKEN", token);
}

process.stdout.write("\nTARGET_TOKEN set on both Workers. The value was never printed.\n");
process.stdout.write("Next: re-run the live acceptance, or ask for a production apply check.\n");
