import { randomBytes } from "node:crypto";
import { storage } from "./storage";

// Generate a short, unambiguous, uppercase alphanumeric invite code that isn't
// already in use. Shared by manager registration and self-serve provisioning so
// both paths mint codes the same way.
export async function generateUniqueInviteCode(): Promise<string> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars (0/O, 1/I)
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = randomBytes(8);
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
    const existing = await storage.getOfficeByInviteCode(code);
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique invite code");
}
