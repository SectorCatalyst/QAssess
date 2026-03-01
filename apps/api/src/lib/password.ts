import bcrypt from 'bcryptjs';

export async function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, 12);
}

export async function verifyPassword(plainText: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainText, passwordHash);
}
