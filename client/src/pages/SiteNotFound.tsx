// Shown when the request hit a subdomain like `foobar.lessonspot.app` that
// doesn't map to any tenant in the database.  Previously this case fell
// through to Book.tsx which rendered Skinner-branded fallbacks (broken UX
// and brand-bleed).  We show a clear "site not found" with a CTA to either
// start a free trial or go back to lessonspot.app.

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SiteNotFound({ host }: { host?: string }) {
  const subdomain = host ? host.split(".")[0] : "this address";
  return (
    <main className="container mx-auto max-w-xl px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">No coach here yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            <span className="font-semibold">{subdomain}.lessonspot.app</span>{" "}
            isn't claimed yet. If you were looking for a specific coach, double-check
            the spelling of the address — even one letter off lands here.
          </p>
          <p className="text-muted-foreground">
            Are you a coach? You can claim this subdomain (or any other) and have your
            own branded booking site live in under a minute.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <Button asChild className="flex-1">
              <a href="https://lessonspot.app/#/signup">Start a free trial</a>
            </Button>
            <Button variant="outline" asChild className="flex-1">
              <a href="https://lessonspot.app">Go to LessonSpot</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
