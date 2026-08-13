import { storage } from "./storage";
import { migratePlaintextUserPasswords } from "./userPasswords";

async function main(): Promise<void> {
  const result = await migratePlaintextUserPasswords(storage);
  console.log(
    `User password migration complete: ${result.migrated} plaintext password(s) hashed; ${result.alreadyHashed} already bcrypt-hashed.`,
  );
}

main().catch((error) => {
  console.error("User password migration failed:", error);
  process.exitCode = 1;
});
