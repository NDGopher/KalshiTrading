const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
for (const f of ["package-lock.json", "yarn.lock"]) {
  const p = path.join(root, f);
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

const ua = process.env.npm_config_user_agent || "";
if (!ua.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
