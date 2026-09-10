"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { BIAS_MAP } from "./bias-map";
import type { SourceItem } from "./source-row";

export function SourceDialog({
  open,
  onOpenChange,
  mode,
  source,
  onChange,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  source: SourceItem;
  onChange: (source: SourceItem) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const id = useId();
  const nameId = `${id}-name`;
  const slugId = `${id}-slug`;
  const urlId = `${id}-url`;
  const rssUrlId = `${id}-rss-url`;
  const biasId = `${id}-bias`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            {mode === "add" ? "Yeni Kaynak Ekle" : "Kaynağı Düzenle"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor={nameId} className="text-xs">Kaynak Adı</Label>
            <Input
              id={nameId}
              placeholder="Örn: Hürriyet"
              value={source.name}
              onChange={(e) => onChange({ ...source, name: e.target.value })}
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={slugId} className="text-xs">Slug (otomatik oluşturulur)</Label>
            <Input
              id={slugId}
              placeholder="Örn: hurriyet"
              value={source.slug}
              onChange={(e) => onChange({ ...source, slug: e.target.value })}
              className="h-8 text-sm font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={urlId} className="text-xs">Web Sitesi URL</Label>
            <Input
              id={urlId}
              placeholder="https://www.hurriyet.com.tr"
              value={source.url}
              onChange={(e) => onChange({ ...source, url: e.target.value })}
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={rssUrlId} className="text-xs">RSS Feed URL</Label>
            <Input
              id={rssUrlId}
              placeholder="https://www.hurriyet.com.tr/rss/anasayfa"
              value={source.rss_url}
              onChange={(e) => onChange({ ...source, rss_url: e.target.value })}
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={biasId} className="text-xs">Yanlılık Etiketi</Label>
            <Select
              value={source.bias}
              onValueChange={(value) =>
                value && onChange({ ...source, bias: value })
              }
            >
              <SelectTrigger id={biasId} className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(BIAS_MAP).map(([value, meta]) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => onOpenChange(false)}
          >
            İptal
          </Button>
          <Button
            size="sm"
            className="text-xs"
            disabled={
              !source.name ||
              !source.url ||
              !source.rss_url ||
              saving
            }
            onClick={onSave}
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
            {mode === "add" ? "Ekle" : "Kaydet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
