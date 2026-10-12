// Builds the PWA into dist/web: hashed bundles under assets/, the service
// worker at the scope root, and the static shell files. Run from the repo root.

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const SRC = "src/web";
const OUT = "dist/web";

async function run(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
}

async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "assets"), { recursive: true });

// Entry names carry a hash so a new deploy never serves stale cache-first assets.
await run([
	"bun", "build", `${SRC}/main.tsx`,
	"--outdir", `${OUT}/assets`,
	"--entry-naming", "[name]-[hash].[ext]",
	"--minify", "--target", "browser", "--splitting",
]);
await run(["bun", "build", `${SRC}/sw.ts`, "--outdir", OUT, "--minify", "--target", "browser"]);

// The service worker discovers what to cache by reading index.html, so every
// bundle file (entry, css, split chunks) must be referenced from it.
const assets = (await readdir(join(OUT, "assets"))).sort();
const entry = assets.find((name) => /^main-.*\.js$/.test(name));
if (entry === undefined) throw new Error("bundle entry main-*.js not found");
const css = assets.filter((name) => name.endsWith(".css"));
const chunks = assets.filter((name) => name.endsWith(".js") && name !== entry);

let html = await Bun.file(join(SRC, "index.html")).text();
const head = [
	...css.map((name) => `<link rel="stylesheet" href="/assets/${name}" />`),
	...chunks.map((name) => `<link rel="modulepreload" href="/assets/${name}" />`),
].join("\n\t\t");
if (!html.includes('src="./main.tsx"')) throw new Error("index.html does not reference ./main.tsx");
html = html.replace('src="./main.tsx"', `src="/assets/${entry}"`).replace("</head>", `\t${head}\n\t</head>`);
await Bun.write(join(OUT, "index.html"), html);

await cp(join(SRC, "manifest.webmanifest"), join(OUT, "manifest.webmanifest"));
await cp(join(SRC, "icons"), join(OUT, "icons"), { recursive: true });

for (const file of await listFiles(OUT)) console.log(file);
