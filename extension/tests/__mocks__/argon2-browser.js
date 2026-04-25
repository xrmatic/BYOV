/**
 * Mock for argon2-browser in Jest tests.
 * Returns deterministic output for the given inputs.
 */

const ArgonType = { Argon2id: 2, Argon2d: 0, Argon2i: 1 };

async function hash({ pass, salt, type: _type, mem: _mem, time: _time, parallelism: _p, hashLen }) {
  // Deterministic fake hash: fill with XOR of pass bytes and salt bytes
  const passBytes = typeof pass === 'string'
    ? new TextEncoder().encode(pass)
    : pass;
  const output = new Uint8Array(hashLen || 32);
  for (let i = 0; i < output.length; i++) {
    output[i] = (passBytes[i % passBytes.length] || 0) ^ (salt[i % salt.length] || 0) ^ 0x42;
  }
  return { hash: output, encoded: Buffer.from(output).toString('hex') };
}

module.exports = { hash, ArgonType };
module.exports.default = { hash, ArgonType };
