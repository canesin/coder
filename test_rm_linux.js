import { createWriteStream, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = join(tmpdir(), "test_rm_open");
if (!existsSync(dir)) {
  import("fs").then(fs => fs.mkdirSync(dir));
}
const file = join(dir, "test.txt");

const stream = createWriteStream(file);
stream.write("hello");

console.log("Stream open.");
try {
  rmSync(file);
  console.log("rmSync succeeded (file deleted while open).");
} catch (e) {
  console.log("rmSync failed:", e.message);
}

stream.end();
