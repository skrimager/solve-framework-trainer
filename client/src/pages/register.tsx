import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { hashToSearch } from "@/lib/hashLocation";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";
import solveLogo from "@assets/solve-framework-logo.png";

type Path = "choose" | "consultant";

export default function Register() {
  // A consultant enrollment email links here with ?code=INVITE so the invite
  // field is prefilled and we drop them straight onto the consultant form.
  const invitedCode = useMemo(
    () => (new URLSearchParams(hashToSearch(window.location.hash)).get("code") ?? "").trim().toUpperCase(),
    [],
  );
  const [path, setPath] = useState<Path>(invitedCode ? "consultant" : "choose");
  const [, navigate] = useLocation();

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm mx-auto space-y-6">
        <div className="text-center space-y-4">
          <img
            src={solveLogo}
            alt="The SOLVE Framework"
            className="mx-auto h-20 w-auto max-w-full"
            data-testid="img-solve-logo"
          />
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-register-title">Create your account</h1>
          <p className="text-sm text-muted-foreground">Discovery architecture practice, not sales scripts.</p>
        </div>

        {path === "choose" && <ChoosePath onChoose={setPath} navigate={navigate} />}
        {path === "consultant" && <ConsultantForm onBack={() => setPath("choose")} initialCode={invitedCode} />}

        <div className="text-center">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
            style={{ color: "#E06D00" }}
            data-testid="link-back-to-login"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}

function ChoosePath({ onChoose, navigate }: { onChoose: (p: Path) => void; navigate: (to: string) => void }) {
  return (
    <Card className="border-2" style={{ borderColor: "#E06D00" }}>
      <CardHeader>
        <CardTitle className="text-lg">How are you signing up?</CardTitle>
        <CardDescription>Choose the option that describes you.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <button
          type="button"
          onClick={() => navigate("/signup")}
          className="w-full text-left rounded-md border px-4 py-3 hover-elevate active-elevate-2"
          data-testid="button-choose-manager"
        >
          <p className="font-medium">I'm a manager setting up my office</p>
          <p className="text-sm text-muted-foreground">Create your office and get an invite code for your consultants.</p>
        </button>
        <button
          type="button"
          onClick={() => onChoose("consultant")}
          className="w-full text-left rounded-md border px-4 py-3 hover-elevate active-elevate-2"
          data-testid="button-choose-consultant"
        >
          <p className="font-medium">I'm a consultant joining my office</p>
          <p className="text-sm text-muted-foreground">Use the invite code your manager gave you.</p>
        </button>
      </CardContent>
    </Card>
  );
}

function ConsultantForm({ onBack, initialCode }: { onBack: () => void; initialCode?: string }) {
  const [inviteCode, setInviteCode] = useState(initialCode ?? "");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await apiRequest("POST", "/api/register/consultant", {
        inviteCode: inviteCode.trim().toUpperCase(),
        username,
        password,
        displayName,
      });
      toast({ title: "Account created", description: "You've joined your office. Please sign in." });
      navigate("/practice");
    } catch (err: any) {
      toast({
        title: "Couldn't join the office",
        description: humanError(err),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="border-2" style={{ borderColor: "#E06D00" }}>
      <CardHeader>
        <CardTitle className="text-lg">Join your office</CardTitle>
        <CardDescription>Enter the invite code your manager shared with you.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field id="inviteCode" label="Invite code" value={inviteCode} onChange={setInviteCode} testId="input-invite-code" />
          <Field id="displayName" label="Your name" value={displayName} onChange={setDisplayName} testId="input-display-name" />
          <Field id="username" label="Username" value={username} onChange={setUsername} autoComplete="username" testId="input-username" />
          <Field id="password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" testId="input-password" />
          <Button
            type="submit"
            className="w-full"
            style={{ backgroundColor: "#E06D00", color: "white" }}
            disabled={isSubmitting}
            data-testid="button-submit-consultant"
          >
            {isSubmitting ? "Joining..." : "Join office"}
          </Button>
          <BackButton onBack={onBack} />
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  testId: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        data-testid={testId}
        required
      />
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="w-full text-center text-sm text-muted-foreground hover:underline"
      data-testid="button-back-to-choose"
    >
      Choose a different option
    </button>
  );
}

function humanError(err: any): string {
  const msg = String(err?.message ?? "");
  // apiRequest throws "<status>: <body>"; surface the server's message when present.
  const match = msg.match(/^\d+:\s*([\s\S]*)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.message) return parsed.message;
    } catch {
      if (match[1]) return match[1];
    }
  }
  return "Please check your details and try again.";
}
