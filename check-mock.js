import test from "node:test";
test("check mock module", (t) => {
  console.log("t.mock:", typeof t.mock);
  console.log("t.mock.module:", typeof t.mock?.module);
});
import { mock } from "node:test";
console.log("mock.module:", typeof mock.module);
