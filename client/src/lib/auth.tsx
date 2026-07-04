import { createContext, useContext, useState, ReactNode } from "react";

export type Level = "beginner" | "intermediate" | "advanced";

export type AuthUser = {
  id: number;
  officeId: number;
  username: string;
  role: "manager" | "consultant" | "qa";
  displayName: string;
  currentLevel: Level;
  leadershipLevel: Level;
  seatActive: boolean;
  isDemoAccount: boolean;
  consultingCertified: boolean;
  consultingCertifiedAt: string | null;
  leadershipCertified: boolean;
  leadershipCertifiedAt: string | null;
};

type AuthContextValue = {
  user: AuthUser | null;
  setUser: (u: AuthUser | null) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
