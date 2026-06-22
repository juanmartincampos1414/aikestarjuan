import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile } from "fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
// Dependencies to bundle into the production build
// Note: stripe-replit-sync is NOT included - it's only used in development
// and causes bundling issues with import.meta.url
const allowlist = [
  "@google/generative-ai",
  "@sendgrid/mail",
  "axios",
  "bcryptjs",
  "connect-pg-simple",
  "cors",
  "csrf-sync",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  // Build ESM bundle (preserves import.meta.url)
  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/index.mjs",
    target: "node20",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
    banner: {
      js: `import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`,
    },
  });

  // Create CJS wrapper that dynamically imports the ESM bundle
  // This allows `npm run start` to work with the existing package.json config
  const cjsWrapper = `// CJS wrapper for ESM bundle
import('./index.mjs').catch(err => {
  console.error('Failed to load ESM bundle:', err);
  process.exit(1);
});
`;
  await writeFile("dist/index.cjs", cjsWrapper);
  console.log("Created CJS wrapper -> dist/index.cjs");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
