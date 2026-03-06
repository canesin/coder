const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.tmpdir(), "test_rm_open_sync");
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
