// Installs the extensionless-import resolver for the test run. Loaded via
// `node --import ./tests/register.mjs` (see the "test" script in package.json).
import { register } from "node:module";
register("./resolve-hook.mjs", import.meta.url);
