import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const source = process.argv[2];
if (!source) throw new Error("Uso: node scripts/import-heimdall-services.mjs /path/Heimdall-Apps");

const output = join(process.cwd(), "public", "service-icons");
await mkdir(output, { recursive: true });

const services = [];
for (const directory of await readdir(source, { withFileTypes: true })) {
  if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
  const appDirectory = join(source, directory.name);
  try {
    const app = JSON.parse(await readFile(join(appDirectory, "app.json"), "utf8"));
    if (!app.name || !app.icon) continue;
    const extension = basename(app.icon).split(".").pop()?.toLowerCase();
    if (!extension || !["png", "svg", "webp", "jpg", "jpeg"].includes(extension)) continue;
    const filename = `${directory.name}.${extension}`;
    await copyFile(join(appDirectory, app.icon), join(output, filename));
    services.push({
      id: app.appid || directory.name,
      slug: directory.name,
      name: app.name,
      icon: `/service-icons/${filename}`,
      website: app.website || "",
      enhanced: Boolean(app.enhanced),
      tileBackground: app.tile_background || "dark",
    });
  } catch (error) {
    console.warn(`Ignorata ${directory.name}: ${error.message}`);
  }
}

services.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
await writeFile(
  join(output, "services.json"),
  `${JSON.stringify({ source: "https://github.com/linuxserver/Heimdall-Apps", importedAt: new Date().toISOString(), count: services.length, services }, null, 2)}\n`,
);
await copyFile(join(source, "LICENSE"), join(output, "HEIMDALL-APPS-LICENSE.txt"));
console.log(`Importati ${services.length} servizi in ${output}`);
