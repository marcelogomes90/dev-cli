import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/lib.ts", "src/supervisor.ts"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  target: "node20",
});
