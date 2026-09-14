// Test-only module resolver.
//
// The app's source uses extensionless relative imports (`from "./kv"`),
// which Next's bundler resolves but plain Node ESM does not. Rather than
// rewriting every import across the codebase — a wide, purely cosmetic diff
// against a repo whose first rule is "change as little as possible" — the
// test runner installs this hook, which retries a failed relative
// resolution with a `.js` extension. Nothing in the shipped app depends on
// it; it exists only so `npm test` can import the real modules unmodified.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && !/\.[mc]?js$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw err;
  }
}
