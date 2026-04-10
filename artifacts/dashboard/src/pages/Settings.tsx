import { useUpdateSettings } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { FileText, Shield, Layers, CheckCircle2, XCircle } from "lucide-react";

/** Production paper/live stack: rule-based keepers only (no Odds API / LLM). */
const KEEPER_STRATEGIES = [
  { name: "Pure Value", description: "Enters when blind model probability diverges from the market after a 1¢ execution cushion.", color: "#a78bfa" },
  { name: "Volume Imbalance", description: "Uses live 24h tape imbalance vs mid — requires real Kalshi volume (not DB estimates).", color: "#60a5fa" },
  { name: "Whale Flow", description: "Large-print proxy on the live tape when volume and liquidity spike together.", color: "#34d399" },
  { name: "Dip Buy", description: "Mean-reversion when price sits well below the 24h rolling mean (price-history from DB).", color: "#22d3ee" },
];

interface SettingsData {
  id: number;
  maxPositionPct: number;
  kellyFraction: number;
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
  maxSimultaneousPositions: number;
  minEdge: number;
  minLiquidity: number;
  minTimeToExpiry: number;
  confidencePenaltyPct: number;
  sportFilters: string[];
  scanIntervalMinutes: number;
  pipelineActive: boolean;
  paperTradingMode: boolean;
  paperBalance: number;
  enabledStrategies: string[] | null;
  targetBetUsd?: number;
  cryptoPriorityWeight?: number;
  weatherPriorityWeight?: number;
  kalshiApiKeySet: boolean;
  kalshiBaseUrl: string | null;
}

const settingsSchema = z.object({
  maxPositionPct: z.coerce.number().min(1).max(50),
  kellyFraction: z.coerce.number().min(0.1).max(1.0),
  maxDrawdownPct: z.coerce.number().min(5).max(100),
  maxConsecutiveLosses: z.coerce.number().min(1).max(20),
  maxSimultaneousPositions: z.coerce.number().min(0).max(10000),
  minEdge: z.coerce.number().min(1).max(50),
  minLiquidity: z.coerce.number().min(10),
  minTimeToExpiry: z.coerce.number().min(1),
  scanIntervalMinutes: z.coerce.number().min(1).max(1440),
  confidencePenaltyPct: z.coerce.number().min(0).max(50),
  sportFilters: z.string(),
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

const API_BASE = `${import.meta.env.BASE_URL}api`;

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/settings`);
      return res.json() as Promise<SettingsData>;
    },
  });
  const [kalshiApiKey, setKalshiApiKey] = useState("");
  const [kalshiBaseUrl, setKalshiBaseUrl] = useState("");
  const [credSaving, setCredSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [paperMode, setPaperMode] = useState(false);
  const [togglingPaper, setTogglingPaper] = useState(false);
  const [enabledStrategies, setEnabledStrategies] = useState<string[]>(KEEPER_STRATEGIES.map(s => s.name));
  const [strategySaving, setStrategySaving] = useState(false);
  
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
        maxSimultaneousPositions: settings.maxSimultaneousPositions ?? 0,
        minEdge: settings.minEdge,
        minLiquidity: settings.minLiquidity,
        minTimeToExpiry: settings.minTimeToExpiry,
        scanIntervalMinutes: settings.scanIntervalMinutes,
        confidencePenaltyPct: settings.confidencePenaltyPct,
        sportFilters: (settings.sportFilters || []).join(", "),
      });
      setKalshiBaseUrl(settings.kalshiBaseUrl || "");
      setPaperMode(settings.paperTradingMode || false);
      const loaded = settings.enabledStrategies;
      const allowed = new Set(KEEPER_STRATEGIES.map((s) => s.name));
      if (Array.isArray(loaded) && loaded.length > 0) {
        const filtered = loaded.filter((s): s is string => typeof s === "string" && allowed.has(s));
        setEnabledStrategies(filtered.length > 0 ? filtered : KEEPER_STRATEGIES.map((s) => s.name));
      } else {
        setEnabledStrategies(KEEPER_STRATEGIES.map(s => s.name));
      }
    }
  }, [settings, reset]);

  const toggleStrategy = useCallback(async (name: string) => {
    const next = enabledStrategies.includes(name)
      ? enabledStrategies.filter(s => s !== name)
      : [...enabledStrategies, name];
    setEnabledStrategies(next);
    setStrategySaving(true);
    try {
      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledStrategies: next }),
      });
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({ title: next.includes(name) ? "Strategy Enabled" : "Strategy Disabled", description: name });
    } catch {
      setEnabledStrategies(enabledStrategies);
      toast({ title: "Error", description: "Failed to save strategy settings.", variant: "destructive" });
    } finally {
      setStrategySaving(false);
    }
  }, [enabledStrategies, queryClient, toast]);

  const onSubmit = (data: SettingsFormValues) => {
    const payload = {
      ...data,
      sportFilters: data.sportFilters.split(",").map((s: string) => s.trim()).filter(Boolean),
    };
    updateMutation.mutate({ data: payload });
  };

  const togglePaperMode = useCallback(async () => {
    setTogglingPaper(true);
    try {
      await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperTradingMode: !paperMode }),
      });
      setPaperMode(!paperMode);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/overview'] });
      toast({ title: paperMode ? "Live Mode" : "Paper Mode", description: paperMode ? "Switched to live trading." : "Switched to paper trading with $5,000 simulated balance." });
    } catch {
      toast({ title: "Error", description: "Failed to toggle mode.", variant: "destructive" });
    } finally {
      setTogglingPaper(false);
    }
  }, [paperMode, queryClient, toast]);

  const resetPaper = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/paper-trades/reset`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({ title: "Paper Trading Reset", description: "Balance restored to $5,000." });
    } catch {
      toast({ title: "Error", description: "Failed to reset paper trades.", variant: "destructive" });
    }
  }, [queryClient, toast]);

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
          <p className="text-muted-foreground mt-1">Manage API credentials, risk parameters, trading mode, and budget.</p>
        </div>

        {isLoading ? (
          <div className="text-center p-12 text-muted-foreground">Loading settings...</div>
        ) : (
          <div className="space-y-6">

            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-yellow-400" />
                  Trading Mode
                </CardTitle>
                <CardDescription>
                  Switch between live and paper trading. Paper mode uses a simulated $5,000 balance.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${paperMode ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" : "bg-green-500/20 text-green-400 border border-green-500/30"}`}>
                        {paperMode ? "PAPER TRADING" : "LIVE TRADING"}
                      </span>
                      {paperMode && (
                        <span className="text-sm text-muted-foreground">
                          Balance: ${(settings?.paperBalance || 5000).toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {paperMode && (
                      <Button variant="outline" size="sm" onClick={resetPaper}>
                        Reset Paper
                      </Button>
                    )}
                    <Button
                      onClick={togglePaperMode}
                      disabled={togglingPaper}
                      variant={paperMode ? "default" : "outline"}
                      className={paperMode ? "bg-green-600 hover:bg-green-700 text-white" : ""}
                    >
                      {togglingPaper ? "Switching..." : paperMode ? "Go Live" : "Switch to Paper"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/10">
              <CardHeader className="border-b border-white/5 bg-black/20">
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-primary" />
                  Strategy Selection
                </CardTitle>
                <CardDescription>
                  Enable or disable individual strategies. Disabled strategies are skipped during evaluation.
                  {strategySaving && <span className="text-primary ml-2 text-xs">Saving...</span>}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {KEEPER_STRATEGIES.map((strategy) => {
                    const isEnabled = enabledStrategies.includes(strategy.name);
                    return (
                      <button
                        key={strategy.name}
                        type="button"
                        onClick={() => toggleStrategy(strategy.name)}
                        disabled={strategySaving}
                        className={`relative flex flex-col gap-3 p-4 rounded-xl border transition-all duration-200 text-left ${
                          isEnabled
                            ? "bg-black/30 border-white/20 ring-1 ring-inset"
                            : "bg-black/10 border-white/5 opacity-50 hover:opacity-70"
                        }`}
                        style={isEnabled ? { borderColor: strategy.color + "60" } : undefined}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ background: strategy.color, opacity: isEnabled ? 1 : 0.3 }} />
                            <span className="text-sm font-semibold text-white">{strategy.name}</span>
                          </div>
                          {isEnabled
                            ? <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
                            : <XCircle className="w-4 h-4 text-destructive/50 flex-shrink-0" />
                          }
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{strategy.description}</p>
                        <div className={`text-[10px] font-bold uppercase tracking-wider ${isEnabled ? "text-success" : "text-muted-foreground/50"}`}>
                          {isEnabled ? "ENABLED" : "DISABLED"}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  {enabledStrategies.length} of {KEEPER_STRATEGIES.length} keepers active. 
                  Changes take effect on the next pipeline cycle.
                </p>
              </CardContent>
            </Card>

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
                      placeholder="https://api.elections.kalshi.com/trade-api/v2"
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
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-primary" />
                  Position Sizing & Drawdown
                </CardTitle>
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

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Max Simultaneous Positions</label>
                  <input 
                    type="number"
                    {...register("maxSimultaneousPositions")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">Maximum open positions at once. Set to 0 for no limit — Kelly sizing controls exposure instead.</p>
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
                  <p className="text-xs text-muted-foreground">Penalty applied to analyst confidence scores.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Scan Interval (mins)</label>
                  <input 
                    type="number"
                    {...register("scanIntervalMinutes")}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">How often the market scan runs.</p>
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
