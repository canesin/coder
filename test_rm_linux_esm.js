import fs from "fs";
import path from "path";
import os from "os";

const dir = path.join(os.tmpdir(), "test_rm_open_esm");
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
const file = path.join(dir, "test.txt");

const stream = fs.createWriteStream(file);
stream.write("hello");

console.log("Stream open.");
try {
  fs.rmSync(file);
  console.log("rmSync succeeded (file deleted while open).");
} catch (e) {
  console.log("rmSync failed:", e.message);
}

stream.end();
fs.rmSync(dir, { recursive: true, force: true });
