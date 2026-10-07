// Mint an API key for the Cloudflare host and print its hash entry.
//
//   bun run apps/host-cloudflare/scripts/api-key.ts create --label posse
//
// The plaintext key is printed ONCE, to stdout, and never stored anywhere. Hand
// it to the caller (Authorization: Bearer <key>) and put only the printed
// `label:hash` entry into the EXECUTOR_API_KEY_HASHES secret (comma-separated for
// several keys; `wrangler secret put EXECUTOR_API_KEY_HASHES`).
import { generateApiKey, hashApiKey } from "../src/auth/api-keys";

const usage = "usage: api-key.ts create [--label <name>]";

const args = process.argv.slice(2);
if (args[0] !== "create") {
  console.error(usage);
  process.exit(1);
}

const labelFlag = args.indexOf("--label");
const label = labelFlag === -1 ? "key" : (args[labelFlag + 1] ?? "");
if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
  console.error(`Invalid label. ${usage}`);
  process.exit(1);
}

const key = generateApiKey();
const hash = await hashApiKey(key);

console.log(`API key (shown once, store it in the caller's secret manager):\n  ${key}\n`);
console.log(`Append this entry to EXECUTOR_API_KEY_HASHES (comma-separated):\n  ${label}:${hash}`);
