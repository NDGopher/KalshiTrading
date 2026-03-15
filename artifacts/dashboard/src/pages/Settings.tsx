import { useGetSettings, useUpdateSettings } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useEffect, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const settingsSchema = z.object({
  maxPositionPct: z.coerce.number().min(1).max(50),
  kellyFraction: z.coerce.number().min(0.1).max(1.0),
  maxDrawdownPct: z.coerce.number().min(5).max(100),
  maxConsecutiveLosses: z.coerce.number().min(1).max(20),
  minEdge: z.coerce.number().min(1).max(50),
  minLiquidity: z.coerce.number().min(10),
  minTimeToExpiry: z.coerce.number().min(1),
  scanIntervalMinutes: z.coerce.number().min(5).max(1440),
  confidencePenaltyPct: z.coerce.number().min(0).max(50),
  sportFilters: z.string(),
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

const API_BASE = `${import.meta.env.BASE_URL}api`;

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useGetSettings();

  const [kalshiApiKey, setKalshiApiKey] = useState("");
  const [kalshiBaseUrl, setKalshiBaseUrl] = useState("");
  const [credSaving, setCredSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);
  
  const updateMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
        toast({ title: "Settings Saved", description: "Risk parameters updated successfully." });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to update settings.", variant: "destructive" });
      }
    }
  });

  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
  });

  useEffect(() => {
    if (settings) {
      reset({
        maxPositionPct: settings.maxPositionPct,
        kellyFraction: settings.kellyFraction,
        maxDrawdownPct: settings.maxDrawdownPct,
        maxConsecutiveLosses: settings.maxConsecutiveLosses,
        minEdge: settings.minEdge,
        minLiquidity: settings.minLiquidity,
        minTimeToExpiry: settings.minTimeToExpiry,
        scanIntervalMinutes: settings.scanIntervalMinutes,
        confidencePenaltyPct: settings.confidencePenaltyPct,
        sportFilters: (settings.sportFilters || []).join(", "),
      });
      setKalshiBaseUrl(settings.kalshiBaseUrl || "");
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsFormValues) => {
    const payload = {
      ...data,
      sportFilters: data.sportFilters.split(",").map((s: string) => s.trim()).filter(Boolean),
    };
    updateMutation.mutate({ data: payload });
  };

  const saveCredentials = useCallback(async () => {
    setCredSaving(true);
    try {
      const body: Record<string, string | null> = {};
      if (kalshiApiKey) body.kalshiApiKey = kalshiApiKey;
      if (kalshiBaseUrl !== (settings?.kalshiBaseUrl || "")) body.kalshiBaseUrl = kalshiBaseUrl || null;
      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      setKalshiApiKey("");
      toast({ title: "Credentials Saved", description: "Kalshi API credentials updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save credentials.", variant: "destructive" });
    } finally {
      setCredSaving(false);
    }
  }, [kalshiApiKey, kalshiBaseUrl, settings, queryClient, toast]);

  const testConnection = useCallback(async () => {
    setTestingConnection(true);
    setConnectionStatus(null);
    try {
      const res = await fetch(`${API_BASE}/settings/test-connection`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setConnectionStatus({ success: true, message: `Connected. Balance: $${(data.balance).toFixed(2)}` });
      } else {
        setConnectionStatus({ success: false, message: data.error || "Connection failed" });
      }
    } catch {
      setConnectionStatus({ success: false, message: "Network error" });
    } finally {
      setTestingConnection(false);
    }
  }, []);

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-8">
        
        <div>
          <h2 className="text-3xl font-bold font-display text-white tracking-tight">Configuration</h2>
          <p className="text-muted-foreground mt-1">Manage API credentials, risk parameters, and agent constraints.</p>
        </div>

        {isLoading ? (
          <div className="text-center p-12 text-muted-foreground">Loading settings...</div>
        ) : (
          <div className="space-y-6">
            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20">
                <CardTitle>Kalshi API Credentials</CardTitle>
                <CardDescription>
                  {settings?.kalshiApiKeySet
                    ? "API key is configured."
                    : "No API key set. Configure one to enable trading."}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">API Key</label>
                    <input
                      type="password"
                      value={kalshiApiKey}
                      onChange={(e) => setKalshiApiKey(e.target.value)}
                      placeholder={settings?.kalshiApiKeySet ? "••••••••••••" : "Enter Kalshi API key"}
                      className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <p className="text-xs text-muted-foreground">Write-only. Never displayed after saving.</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">Base URL (optional)</label>
                    <input
                      type="text"
                      value={kalshiBaseUrl}
                      onChange={(e) => setKalshiBaseUrl(e.target.value)}
                      placeholder="https://trading-api.kalshi.com/trade-api/v2"
                      className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <p className="text-xs text-muted-foreground">Override for demo/sandbox environments.</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    onClick={saveCredentials}
                    disabled={credSaving || (!kalshiApiKey && kalshiBaseUrl === (settings?.kalshiBaseUrl || ""))}
                    className="bg-primary text-black hover:bg-primary/90 font-semibold"
                  >
                    {credSaving ? "Saving..." : "Save Credentials"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={testConnection}
                    disabled={testingConnection}
                  >
                    {testingConnection ? "Testing..." : "Test Connection"}
                  </Button>
                  {connectionStatus && (
                    <span className={`text-sm ${connectionStatus.success ? "text-green-400" : "text-red-400"}`}>
                      {connectionStatus.message}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            
            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20">
                <CardTitle>Position Sizing & Drawdown</CardTitle>
                <CardDescription>Control how much capital is deployed.</CardDescription>
              </CardHeader>
              <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Max Position Size (%)</label>
                  <input 
                    type="number" step="any"
                    {...register("maxPositionPct")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  {errors.maxPositionPct && <p className="text-xs text-destructive">{errors.maxPositionPct.message}</p>}
                  <p className="text-xs text-muted-foreground">Hard cap on bankroll per trade.</p>
                </div>
                
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Kelly Fraction</label>
                  <input 
                    type="number" step="0.05"
                    {...register("kellyFraction")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  {errors.kellyFraction && <p className="text-xs text-destructive">{errors.kellyFraction.message}</p>}
                  <p className="text-xs text-muted-foreground">E.g., 0.25 for Quarter Kelly sizing.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Max Drawdown Halt (%)</label>
                  <input 
                    type="number" step="any"
                    {...register("maxDrawdownPct")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">Pipeline stops if bankroll drops this much.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Max Consecutive Losses</label>
                  <input 
                    type="number"
                    {...register("maxConsecutiveLosses")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">Circuit breaker for losing streaks.</p>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20">
                <CardTitle>Auditor Constraints</CardTitle>
                <CardDescription>Filters applied before trade execution.</CardDescription>
              </CardHeader>
              <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Minimum Edge (%)</label>
                  <input 
                    type="number" step="any"
                    {...register("minEdge")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">Model prob minus implied prob.</p>
                </div>
                
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Min Liquidity ($)</label>
                  <input 
                    type="number"
                    {...register("minLiquidity")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">Avoid illiquid ghost markets.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Min Time to Expiry (mins)</label>
                  <input 
                    type="number"
                    {...register("minTimeToExpiry")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">Don't trade right before settlement.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Confidence Penalty (%)</label>
                  <input 
                    type="number" step="any"
                    {...register("confidencePenaltyPct")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  {errors.confidencePenaltyPct && <p className="text-xs text-destructive">{errors.confidencePenaltyPct.message}</p>}
                  <p className="text-xs text-muted-foreground">Penalty applied to analyst confidence scores.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Scan Interval (mins)</label>
                  <input 
                    type="number"
                    {...register("scanIntervalMinutes")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">How often the Scanner agent runs.</p>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20">
                <CardTitle>Sport Filters</CardTitle>
                <CardDescription>Which sports the scanner targets.</CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Active Sports</label>
                  <input 
                    type="text"
                    {...register("sportFilters")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  {errors.sportFilters && <p className="text-xs text-destructive">{errors.sportFilters.message}</p>}
                  <p className="text-xs text-muted-foreground">Comma-separated list: NFL, NBA, MLB, Soccer</p>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button 
                type="submit" 
                size="lg"
                disabled={!isDirty || updateMutation.isPending}
                className="bg-primary text-black hover:bg-primary/90 font-semibold px-8 shadow-primary/20 shadow-lg"
              >
                {updateMutation.isPending ? "Saving..." : "Save Configuration"}
              </Button>
            </div>
          </form>
          </div>
        )}
      </div>
    </Layout>
  );
}
