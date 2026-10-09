import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["openclaw/*"],
  legalComments: "inline",
});
