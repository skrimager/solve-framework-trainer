import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Check, Copy } from "lucide-react";

type Path = "choose" | "manager" | "consultant";

export default function Register() {
  const [path, setPath] = useState<Path>("choose");
  const [, navigate] = useLocation();

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm mx-auto space-y-6">
        <div className="text-center space-y-4">
          <div
            className="mx-auto w-20 h-20 rounded-3xl flex items-center justify-center shadow-lg"
            style={{ backgroundColor: "#0A1A30", boxShadow: "0 8px 30px rgba(224,109,0,0.35)" }}
            aria-hidden="true"
          >
            <SolveMark />
          </div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-register-title">Create your account</h1>
          <p className="text-sm text-muted-foreground">Discovery architecture practice, not sales scripts.</p>
        </div>

        {path === "choose" && <ChoosePath onChoose={setPath} />}
        {path === "manager" && <ManagerForm onBack={() => setPath("choose")} />}
        {path === "consultant" && <ConsultantForm onBack={() => setPath("choose")} />}

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

function ChoosePath({ onChoose }: { onChoose: (p: Path) => void }) {
  return (
    <Card className="border-2" style={{ borderColor: "#E06D00" }}>
      <CardHeader>
        <CardTitle className="text-lg">How are you signing up?</CardTitle>
        <CardDescription>Choose the option that describes you.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <button
          type="button"
          onClick={() => onChoose("manager")}
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

function ManagerForm({ onBack }: { onBack: () => void }) {
  const [officeName, setOfficeName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/register/manager", { officeName, username, password, displayName });
      const data = await res.json();
      setInviteCode(data.office.inviteCode);
    } catch (err: any) {
      toast({
        title: "Couldn't create your office",
        description: humanError(err),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  function copyCode() {
    if (!inviteCode) return;
    navigator.clipboard?.writeText(inviteCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (inviteCode) {
    return (
      <Card className="border-2" style={{ borderColor: "#E06D00" }}>
        <CardHeader>
          <CardTitle className="text-lg">Your office is ready</CardTitle>
          <CardDescription>Share this invite code with your consultants so they can join your office.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border-2 border-dashed p-4 text-center" style={{ borderColor: "#E06D00" }}>
            <p className="text-xs text-muted-foreground mb-1">Invite code</p>
            <p className="text-3xl font-bold tracking-widest" data-testid="text-generated-invite-code">{inviteCode}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={copyCode}
              data-testid="button-copy-invite-code"
            >
              {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
              {copied ? "Copied" : "Copy code"}
            </Button>
          </div>
          <Button
            type="button"
            className="w-full"
            style={{ backgroundColor: "#E06D00", color: "white" }}
            onClick={() => navigate("/")}
            data-testid="button-go-to-signin"
          >
            Continue to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-2" style={{ borderColor: "#E06D00" }}>
      <CardHeader>
        <CardTitle className="text-lg">Set up your office</CardTitle>
        <CardDescription>You'll be the manager for this office.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field id="officeName" label="Office name" value={officeName} onChange={setOfficeName} testId="input-office-name" />
          <Field id="displayName" label="Your name" value={displayName} onChange={setDisplayName} testId="input-display-name" />
          <Field id="username" label="Username" value={username} onChange={setUsername} autoComplete="username" testId="input-username" />
          <Field id="password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" testId="input-password" />
          <Button
            type="submit"
            className="w-full"
            style={{ backgroundColor: "#E06D00", color: "white" }}
            disabled={isSubmitting}
            data-testid="button-submit-manager"
          >
            {isSubmitting ? "Creating..." : "Create office"}
          </Button>
          <BackButton onBack={onBack} />
        </form>
      </CardContent>
    </Card>
  );
}

function ConsultantForm({ onBack }: { onBack: () => void }) {
  const [inviteCode, setInviteCode] = useState("");
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
      navigate("/");
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

function SolveMark() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-label="SOLVE Framework logo">
      <path
        d="M4 16c0-2 1.5-3 3-3s2 1 3 1 1.5-1 3-1 3 1 3 3"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="15.5" cy="8" r="3.25" fill="#E06D00" />
    </svg>
  );
}
