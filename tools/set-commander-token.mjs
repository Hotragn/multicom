// Rotate COMMANDER_TOKEN on the room Worker and print the new value.
//
//   node tools/set-commander-token.mjs
//
// Unlike TARGET_TOKEN, which only the two Workers ever need, the commander
// capability is meant to be held by a person: it is what makes a browser able
// to approve a production action. Cloudflare secrets are write-only, so if the
// current value was not saved anywhere it cannot be read back - rotating is the
// way to get a known one.
//
// The value is printed once, here, on your machine. Treat it like the private
// link it is.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const roomDir = fileURLToPath(new URL("../worker/", import.meta.url));

function putSecret(cwd, name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, "secret", "put", name], {
      cwd,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler exited ${code} while setting ${name}`));
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

const token = randomBytes(32).toString("hex");
await putSecret(roomDir, "COMMANDER_TOKEN", token);

// Hand it to the verifier directly. Routing this through a shell variable
// invited a stale value to linger and be mistaken for a rejected token.
const tokenFile = fileURLToPath(new URL("../.commander-token", import.meta.url));
await writeFile(tokenFile, token, { mode: 0o600 });

process.stdout.write("\nCOMMANDER_TOKEN rotated on multicom-room.\n\n");
process.stdout.write("Commander link:\n");
process.stdout.write(`  https://multicom-web.pages.dev/?demo=1&commander=${token}\n\n`);
process.stdout.write("For the acceptance run, nothing to copy:\n");
process.stdout.write("  npm run verify:prod\n\n");
process.stdout.write("Saved to .commander-token (gitignored, owner-only).\n");
process.stdout.write("Any previously issued commander link stops working now.\n");
