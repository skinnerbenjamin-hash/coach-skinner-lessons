import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FileText, ExternalLink, Image as ImageIcon, Lock, Search, Video } from "lucide-react";
import { useTenant } from "@/hooks/use-tenant";

type Resource = {
  id: number;
  type: "pdf" | "link" | "image" | "video";
  category: string;
  title: string;
  description: string | null;
  url: string | null;
  filePath: string | null;
  createdAt: number;
};

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function categoryLabel(c: string): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function iconFor(type: Resource["type"]) {
  if (type === "pdf") return <FileText className="h-5 w-5" />;
  if (type === "image") return <ImageIcon className="h-5 w-5" />;
  if (type === "video") return <Video className="h-5 w-5" />;
  return <ExternalLink className="h-5 w-5" />;
}

function resourceHref(r: Resource): string {
  if (r.type === "link") return r.url || "#";
  if (r.filePath) {
    // server serves resources at /uploads/resources/<filename>
    const name = r.filePath.split("/").pop();
    return `${API_BASE}/uploads/resources/${name}`;
  }
  return "#";
}

export default function Resources() {
  const [emailInput, setEmailInput] = useState("");
  const [activeEmail, setActiveEmail] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("all");
  const { toast } = useToast();
  const { data: tenantInfo } = useTenant();
  const businessName = tenantInfo?.name || "the instructor";

  useEffect(() => {
    try {
      const stored = localStorage.getItem("csb-last-email");
      if (stored) {
        setEmailInput(stored);
        setActiveEmail(stored);
      }
    } catch {}
  }, []);

  const { data, isLoading, isError, error } = useQuery<{ resources: Resource[]; categories: Array<{ id: string; label: string } | string> }>({
    queryKey: ["/api/resources", activeEmail],
    queryFn: async () => {
      const r = await apiRequest(
        "GET",
        `/api/resources?proofEmail=${encodeURIComponent(activeEmail!)}`
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.message || "Couldn't load resources");
      }
      return r.json();
    },
    enabled: !!activeEmail,
    retry: false,
  });

  function onLookup() {
    const email = emailInput.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      toast({ variant: "destructive", title: "Enter a valid email" });
      return;
    }
    try { localStorage.setItem("csb-last-email", email); } catch {}
    setActiveEmail(email);
  }

  const resources = data?.resources ?? [];
  const categories = (data?.categories ?? []).map((c) =>
    typeof c === "string" ? { id: c, label: categoryLabel(c) } : c
  );
  const filtered = category === "all" ? resources : resources.filter(r => r.category === category);

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Resource library</h1>
        <p className="text-sm text-muted-foreground">
          Drills, guides, videos, and photos to help your player keep growing between lessons.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <Label htmlFor="resources-email" className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Enter the email you signed up with
          </Label>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              id="resources-email"
              data-testid="input-resources-email"
              type="email"
              placeholder="you@example.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onLookup(); }}
            />
            <Button onClick={onLookup} data-testid="button-resources-lookup">
              <Search className="h-4 w-4 mr-2" />
              Open library
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The library is only available to people who have booked or signed up. If your email
            isn't recognized, book a lesson first or reach out to {businessName}.
          </p>
        </CardContent>
      </Card>

      {isError && activeEmail && (
        <Alert variant="destructive">
          <AlertDescription data-testid="text-resources-error">
            {(error as Error)?.message || "We couldn't find that email. Double-check the address you used to sign up."}
          </AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="resources-filter" className="text-sm">Filter by skill</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="resources-filter" className="w-[200px]" data-testid="select-resources-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {filtered.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No resources here yet. Check back soon.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {filtered.map((r) => (
                <a
                  key={r.id}
                  href={resourceHref(r)}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-resource-${r.id}`}
                  className="block"
                >
                  <Card className="h-full hover-elevate">
                    <CardContent className="pt-6 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          {iconFor(r.type)}
                          <span className="text-xs uppercase tracking-wide">{r.type}</span>
                        </div>
                        <Badge variant="secondary">{categoryLabel(r.category)}</Badge>
                      </div>
                      <div className="font-medium" data-testid={`text-resource-title-${r.id}`}>{r.title}</div>
                      {r.description && (
                        <p className="text-sm text-muted-foreground">{r.description}</p>
                      )}
                    </CardContent>
                  </Card>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
