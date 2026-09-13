import { hash, verify } from '@node-rs/argon2';

// Algorithm defaults to Argon2id in @node-rs/argon2.
const options = {
  memoryCost: 19 * 1024, // 19 MiB (OWASP minimum recommendation)
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, options);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, options);
  } catch {
    return false;
  }
}
