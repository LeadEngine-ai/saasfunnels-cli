import { expect, it } from "vitest";
import { planConstantResolver } from "../src/plan-constants.js";
it("resolves imported aliases but never unrelated constants or comments", () => {
  const resolve = planConstantResolver(
    new Map([
      [
        "src/plans.ts",
        'export const PLANS={PRO:"pro"} as const; export const FREE="free";',
      ],
      [
        "src/other.ts",
        'export const PLANS={PRO:"enterprise"}; // export const BAD="pro"',
      ],
      ["src/gate.ts", 'import {PLANS as LEVELS,FREE} from "./plans.js";'],
      ["src/unbound.ts", "// nothing imported"],
    ]),
  );
  expect(resolve("src/gate.ts", "LEVELS.PRO")).toBe("pro");
  expect(resolve("src/gate.ts", "FREE")).toBe("free");
  expect(resolve("src/unbound.ts", "PLANS.PRO")).toBeNull();
  expect(resolve("src/other.ts", "BAD")).toBeNull();
});
it("does not resolve a module constant through a shadowing parameter or local binding", () => {
  const source = `const LEVEL = "pro";
function gate(plan, LEVEL) { if (plan === LEVEL) return false; }
function local(plan) { const LEVEL = userValue; if (plan === LEVEL) return false; }
function moduleGate(plan) { if (plan === LEVEL) return false; }`;
  const resolve = planConstantResolver(new Map([["gate.ts", source]]));
  expect(resolve("gate.ts", "LEVEL", 2)).toBeNull();
  expect(resolve("gate.ts", "LEVEL", 3)).toBeNull();
  expect(resolve("gate.ts", "LEVEL", 4)).toBe("pro");
});
