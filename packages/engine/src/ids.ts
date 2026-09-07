import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // crockford-ish, lowercase, no i/l/o/u

function randomToken(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[(bytes[i] as number) % 32];
  return out;
}

export const newTaskId = (): string => `t_${randomToken(14)}`;
export const newSeriesId = (): string => `s_${randomToken(14)}`;
export const newReminderId = (): string => `r_${randomToken(14)}`;
export const newSecret = (): string => randomToken(40);
