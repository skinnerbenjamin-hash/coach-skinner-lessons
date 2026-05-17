// ResetPassword — page reached via the link in the password-reset email.
// URL shape: https://<slug>.lessonspot.app/?token=XXXX#/reset
// (token is in the query string, route lives in the hash since the app uses
// hash routing).  We parse window.location.search on mount.
//
// On success, we show a brief confirmation and bounce the user to /#/admin
// so they can log in with the new password.  All sessions for the tenant are
// invalidated server-side, so even a logged-in admin must sign in again.
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff } from "lucide-react";

export default function ResetPassword() {
  const { toast } = useToast();
  const [token, setToken] = useState<string>("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token") || "";
    setToken(t);
  }, []);

  const reset = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/reset", { token, password });
    },
    onSuccess: () => {
      setDone(true);
      toast({
        title: "Password updated",
        description: "Sign in with your new password.",
      });
      // Strip ?token=... and route to admin sign-in.
      setTimeout(() => {
        const cleanPath = window.location.pathname;
        window.history.replaceState({}, "", cleanPath + "#/admin");
        window.location.reload();
      }, 1500);
    },
    onError: (e: any) => {
      toast({
        title: "Could not reset password",
        description: e?.message?.replace(/^\d+:\s*/, "") || "Try requesting a new reset link.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      toast({ title: "Missing reset link", description: "Open the link from your email again.", variant: "destructive" });
      return;
    }
    if (password.length < 6) {
      toast({ title: "Password too short", description: "Use at least 6 characters.", variant: "destructive" });
      return;
    }
    if (password !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    reset.mutate();
  };

  return (
    <div className="mx-auto max-w-md px-4 sm:px-6 py-10">
      <Card>
        <CardContent className="p-6 space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Reset password</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Choose a new password for your admin account.
            </p>
          </div>
          {!token ? (
            <div className="text-sm text-destructive">
              This reset link is missing a token. Open the link from your email again, or request a new one from the sign-in page.
            </div>
          ) : done ? (
            <div className="text-sm text-muted-foreground">
              Password updated. Redirecting to sign in…
            </div>
          ) : (
            <form className="space-y-3" onSubmit={handleSubmit}>
              <div className="space-y-1">
                <Label htmlFor="reset-password">New password</Label>
                <div className="relative">
                  <Input
                    id="reset-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="pr-10"
                    data-testid="input-reset-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(s => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    data-testid="button-toggle-reset-password"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">At least 6 characters.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="reset-confirm">Confirm new password</Label>
                <Input
                  id="reset-confirm"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  data-testid="input-reset-confirm"
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={reset.isPending}
                data-testid="button-reset-submit"
              >
                {reset.isPending ? "Saving…" : "Update password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
