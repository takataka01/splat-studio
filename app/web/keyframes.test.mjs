// Run: node app/web/keyframes.test.mjs
import assert from "node:assert/strict";
import {
  evaluate, setKey, removeKeyAt, moveKeys, setValueAtTime, easeInOut, cubicBezier,
  orbitKeys, prevKeyTime, nextKeyTime, normalizeScene, makeScene,
} from "./keyframes.js";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok -", name); };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("no keys returns static value (copied)", () => {
  const p = { value: [1, 2, 3], keys: [] };
  const v = evaluate(p, 10);
  assert.deepEqual(v, [1, 2, 3]);
  v[0] = 9;
  assert.equal(p.value[0], 1);
});

test("linear vector interpolation and clamping", () => {
  const p = { value: [0, 0, 0], keys: [] };
  setKey(p, 10, [0, 0, 0]);
  setKey(p, 0, [10, 20, -10]);
  assert.deepEqual(p.keys.map((k) => k.t), [0, 10]);
  assert.deepEqual(evaluate(p, 5), [5, 10, -5]);
  assert.deepEqual(evaluate(p, -3), [10, 20, -10]);
  assert.deepEqual(evaluate(p, 99), [0, 0, 0]);
});

test("scalar + hold", () => {
  const p = { value: 0, keys: [{ t: 0, v: 1, interp: "hold" }, { t: 10, v: 5, interp: "linear" }] };
  assert.equal(evaluate(p, 9.99), 1);
  assert.equal(evaluate(p, 10), 5);
});

test("ease is symmetric bezier(0.42,0,0.58,1)", () => {
  near(easeInOut(0.5), 0.5, 1e-5);
  assert.ok(easeInOut(0.1) < 0.1);
  assert.ok(easeInOut(0.9) > 0.9);
  near(easeInOut(0.25) + easeInOut(0.75), 1, 1e-5);
  const lin = cubicBezier(0, 0, 1, 1);
  near(lin(0.3), 0.3, 1e-5);
  const p = { value: 0, keys: [{ t: 0, v: 0, interp: "ease" }, { t: 10, v: 10 }] };
  near(evaluate(p, 5), 5, 1e-4);
  assert.ok(evaluate(p, 2) < 2);
});

test("setKey replaces at same frame, removeKeyAt", () => {
  const p = { value: 0, keys: [] };
  setKey(p, 3, 1); setKey(p, 3, 2, "hold");
  assert.equal(p.keys.length, 1);
  assert.equal(p.keys[0].v, 2);
  assert.equal(p.keys[0].interp, "hold");
  assert.ok(removeKeyAt(p, 3));
  assert.equal(p.keys.length, 0);
});

test("moveKeys overwrites collided key", () => {
  const p = { value: 0, keys: [] };
  setKey(p, 0, 0); setKey(p, 5, 5); setKey(p, 10, 10);
  moveKeys(p, [p.keys[0]], 5);
  assert.deepEqual(p.keys.map((k) => [k.t, k.v]), [[5, 0], [10, 10]]);
});

test("setValueAtTime semantics", () => {
  const p = { value: 0, keys: [] };
  assert.deepEqual(setValueAtTime(p, 4, 7), { keyed: false });
  assert.equal(p.value, 7);
  setKey(p, 0, 1);
  assert.equal(setValueAtTime(p, 4, 3).dirty, true);
  assert.equal(p.keys.length, 1);
  assert.equal(setValueAtTime(p, 4, 3, { autoKey: true }).keyed, true);
  assert.equal(p.keys.length, 2);
  setValueAtTime(p, 0, 9);
  assert.equal(p.keys[0].v, 9);
});

test("orbit keys", () => {
  const k = orbitKeys({ target: [0, 1, 0], radius: 2, height: 1.5, frames: 8, step: 4 });
  assert.deepEqual(k.map((x) => x.t), [0, 4, 8]);
  near(k[0].v[2], 2); near(k[1].v[2], -2); near(k[2].v[2], 2);
  assert.equal(k[0].v[1], 1.5);
});

test("prev/next key time", () => {
  assert.equal(prevKeyTime([0, 5, 10], 5), 0);
  assert.equal(nextKeyTime([0, 5, 10], 5), 10);
  assert.equal(nextKeyTime([0, 5], 5), null);
});

test("normalizeScene adds camera + defaults", () => {
  const s = normalizeScene({ layers: [{ type: "splat", name: "x", props: { position: { value: [1, 2, 3] } } }] });
  assert.equal(s.layers[0].type, "camera");
  assert.deepEqual(s.layers[1].props.position.keys, []);
  assert.equal(s.layers[1].props.opacity.value, 1);
  assert.equal(s.comp.fps, makeScene().comp.fps);
});

console.log(`\n${n} tests passed`);
