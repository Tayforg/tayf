import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  icon: Icon,
  label,
  value,
  variant = "default",
  hint,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  variant?: "default" | "warning";
  hint?: string;
}) {
  return (
    <Card className="animate-fade-up hover-lift">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div
            className={`rounded-md p-2 ${
              variant === "warning"
                ? "bg-amber-500/15 text-amber-500"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <p className="font-mono text-2xl font-semibold text-brand tabular-nums">{value}</p>
            <p className="font-sans text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
