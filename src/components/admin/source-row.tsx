import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";
import { biasColor, biasLabel } from "./bias-map";

export interface SourceItem {
  id: string;
  name: string;
  slug: string;
  url: string;
  rss_url: string;
  bias: string;
  active: boolean;
}

export function SourceRow({
  source,
  actionLoading,
  onEdit,
  onToggle,
  onDelete,
}: {
  source: SourceItem;
  actionLoading: string | null;
  onEdit: (source: SourceItem) => void;
  onToggle: (source: SourceItem) => void;
  onDelete: (source: SourceItem) => void;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors hover-lift ${
        source.active ? "hover:bg-muted/50" : "opacity-50 bg-muted/20"
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-sans font-semibold">{source.name}</span>
            <Badge
              variant="outline"
              className={`font-mono text-[10px] ${biasColor(source.bias)}`}
            >
              {biasLabel(source.bias)}
            </Badge>
            {!source.active && (
              <Badge variant="secondary" className="text-[10px]">
                Devre Dışı
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">
              {source.rss_url}
            </span>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Kaynak sitesini yeni sekmede aç"
              className="text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
            </a>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onEdit(source)}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          variant={source.active ? "outline" : "secondary"}
          size="sm"
          className="text-[11px] h-7 px-2"
          disabled={actionLoading === `toggle_${source.slug}`}
          onClick={() => onToggle(source)}
        >
          {source.active ? (
            <span className="text-brand">Devre Dışı Bırak</span>
          ) : (
            <span className="text-muted-foreground">Aktifleştir</span>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive"
          onClick={() => onDelete(source)}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
