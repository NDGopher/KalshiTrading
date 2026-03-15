import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FlaskConical, Play, TrendingUp, TrendingDown, BarChart3, Target } from "lucide-react";

interface BacktestRun {
  id: number;
  strategyName: string;
  status: string;
  startDate: string;
  endDate: string;
  marketsEvaluated: number;
  tradesSimulated: number;
  totalPnl: number;
  winRate: number;
  roi: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  avgEdge: number | null;
  avgClv: number | null;
  bestStreak: number | null;
  worstStreak: number | null;
  dipCatchSuccessRate: number | null;
  createdAt: string;
}

interface BacktestTrade {
  id: number;
  kalshiTicker: string;
  title: string;
  strategyName: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  outcome: string;
  clv: number | null;
  modelProbability: number;
  edge: number;
  confidence: number;
  reasoning: string | null;
  marketResult: string | null;
  dipCatch: boolean | null;
  distanceFromPeak: number | null;
}

interface StrategySummary {
  strategyName: string;
  totalRuns: number;
  totalTrades: number;
  avgPnl: number;
  avgWinRate: number;
  avgRoi: number | null;
  avgClv: number | null;
  avgSharpe: number | null;
  dipCatchSuccessRate: number | null;
  bestRunId: number | null;
  bestRunPnl: number | null;
}

const API_BASE = `${import.meta.env.BASE_URL}api`;

function useStrategies() {
  return useQuery({
    queryKey: ["/api/backtest/strategies"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/backtest/strategies`);
      return res.json() as Promise<{ strategies: string[] }>;
    },
  });
}

function useBacktestResults() {
  return useQuery({
    queryKey: ["/api/backtest/results"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/backtest/results`);
      return res.json() as Promise<{ runs: BacktestRun[]; strategyAggregates: StrategySummary[] }>;
    },
    refetchInterval: 5000,
  });
}

function useBacktestTrades(runId: number | null) {
  return useQuery({
    queryKey: ["/api/backtest/trades", runId],
    queryFn: async () => {
      if (!runId) return { trades: [] as BacktestTrade[] };
      const res = await fetch(`${API_BASE}/backtest/trades/${runId}`);
      return res.json() as Promise<{ trades: BacktestTrade[] }>;
    },
    enabled: !!runId,
  });
}

export default function Backtest() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: strategiesData } = useStrategies();
  const { data: resultsData } = useBacktestResults();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const { data: tradesData } = useBacktestTrades(selectedRunId);

  const [strategy, setStrategy] = useState("Pure Value");
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2025-03-01");
  const [initialBankroll, setInitialBankroll] = useState(5000);
  const [useAi, setUseAi] = useState(false);
  const [running, setRunning] = useState(false);

  const runBacktest = async () => {
    setRunning(true);
    try {
      const res = await fetch(`${API_BASE}/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyName: strategy,
          startDate,
          endDate,
          initialBankroll,
          useAiAnalysis: useAi,
        }),
      });
      const data = await res.json();
      if (data.runId) {
        toast({ title: "Backtest Complete", description: `Run #${data.runId} finished` });
        queryClient.invalidateQueries({ queryKey: ["/api/backtest/results"] });
        setSelectedRunId(data.runId);
      } else {
        toast({ title: "Error", description: data.error || "Backtest failed", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to run backtest", variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const runs = resultsData?.runs || [];
  const trades = tradesData?.trades || [];
  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const strategySummaries = resultsData?.strategyAggregates || [];

  return (
    <Layout>
      <div className="space-y-8">
        <div>
          <h2 className="text-3xl font-bold font-display text-white tracking-tight">Backtesting Engine</h2>
          <p className="text-muted-foreground mt-1">Test strategies against historical settled markets.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="glass-panel border-white/10">
            <CardHeader className="border-b border-white/5 bg-black/20">
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="w-5 h-5 text-primary" />
                Run Backtest
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Strategy</label>
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white"
                >
                  <option value="All">All Strategies</option>
                  {(strategiesData?.strategies || ["Pure Value"]).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">Start Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white">End Date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white">Initial Bankroll ($)</label>
                <input
                  type="number"
                  value={initialBankroll}
                  onChange={(e) => setInitialBankroll(Number(e.target.value))}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={useAi}
                  onChange={(e) => setUseAi(e.target.checked)}
                  className="h-4 w-4 rounded border-white/10 bg-black/50"
                />
                <label className="text-sm text-muted-foreground">Use AI analysis (costs API credits)</label>
              </div>
              <Button
                onClick={runBacktest}
                disabled={running}
                className="w-full bg-primary text-black hover:bg-primary/90 font-semibold"
              >
                {running ? (
                  "Running..."
                ) : (
                  <span className="flex items-center gap-2"><Play className="w-4 h-4" /> Run Backtest</span>
                )}
              </Button>
            </CardContent>
          </Card>

          <div className="lg:col-span-2 space-y-6">
            {selectedRun && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Total P&L</div>
                      <div className={`text-2xl font-mono font-bold mt-1 ${selectedRun.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        ${selectedRun.totalPnl?.toFixed(2)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Win Rate</div>
                      <div className="text-2xl font-mono font-bold mt-1 text-white">
                        {(selectedRun.winRate * 100).toFixed(1)}%
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Trades</div>
                      <div className="text-2xl font-mono font-bold mt-1 text-white">
                        {selectedRun.tradesSimulated}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Sharpe Ratio</div>
                      <div className="text-2xl font-mono font-bold mt-1 text-white">
                        {selectedRun.sharpeRatio?.toFixed(2) || "N/A"}
                      </div>
                    </CardContent>
                  </Card>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">ROI</div>
                      <div className={`text-lg font-mono font-bold mt-1 ${(selectedRun.roi ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {selectedRun.roi?.toFixed(1) ?? "N/A"}%
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Avg CLV</div>
                      <div className={`text-lg font-mono font-bold mt-1 ${(selectedRun.avgClv ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {selectedRun.avgClv != null ? (selectedRun.avgClv * 100).toFixed(2) + "%" : "N/A"}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Best / Worst Streak</div>
                      <div className="text-lg font-mono font-bold mt-1 text-white">
                        {selectedRun.bestStreak ?? 0}W / {selectedRun.worstStreak ?? 0}L
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="glass-panel border-white/10">
                    <CardContent className="p-4 text-center">
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Dip Catch Rate</div>
                      <div className="text-lg font-mono font-bold mt-1 text-white">
                        {selectedRun.dipCatchSuccessRate != null ? (selectedRun.dipCatchSuccessRate * 100).toFixed(1) + "%" : "N/A"}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}

            {strategySummaries.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20">
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-primary" />
                    Strategy Performance Summary
                  </CardTitle>
                  <CardDescription>Aggregated results across all backtest runs, grouped by strategy</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/10 bg-black/30">
                          <th className="text-left p-3 font-medium text-muted-foreground">Strategy</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">Runs</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">Trades</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">Avg P&L</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">Win Rate</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">ROI</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">CLV</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">Sharpe</th>
                          <th className="text-right p-3 font-medium text-muted-foreground">Dip Catch</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strategySummaries.map((s) => (
                          <tr key={s.strategyName} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                            <td className="p-3 font-medium text-white">{s.strategyName}</td>
                            <td className="p-3 text-right font-mono text-white">{s.totalRuns}</td>
                            <td className="p-3 text-right font-mono text-white">{s.totalTrades}</td>
                            <td className={`p-3 text-right font-mono ${s.avgPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                              ${s.avgPnl.toFixed(2)}
                            </td>
                            <td className="p-3 text-right font-mono text-white">{s.avgWinRate.toFixed(1)}%</td>
                            <td className={`p-3 text-right font-mono ${(s.avgRoi ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {s.avgRoi != null ? `${s.avgRoi.toFixed(1)}%` : "—"}
                            </td>
                            <td className={`p-3 text-right font-mono ${(s.avgClv ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {s.avgClv != null ? s.avgClv.toFixed(1) : "—"}
                            </td>
                            <td className="p-3 text-right font-mono text-white">{s.avgSharpe != null ? s.avgSharpe.toFixed(2) : "—"}</td>
                            <td className="p-3 text-right font-mono text-white">
                              {s.dipCatchSuccessRate != null ? `${s.dipCatchSuccessRate.toFixed(1)}%` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {trades.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20">
                  <CardTitle>Backtest Trades</CardTitle>
                  <CardDescription>
                    {trades.length} simulated trades for Run #{selectedRunId}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto max-h-[500px]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card/90 backdrop-blur-sm border-b border-white/5">
                        <tr>
                          <th className="text-left p-3 text-muted-foreground font-medium">Market</th>
                          <th className="text-left p-3 text-muted-foreground font-medium">Strategy</th>
                          <th className="text-center p-3 text-muted-foreground font-medium">Side</th>
                          <th className="text-right p-3 text-muted-foreground font-medium">Entry</th>
                          <th className="text-right p-3 text-muted-foreground font-medium">Edge</th>
                          <th className="text-right p-3 text-muted-foreground font-medium">CLV</th>
                          <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
                          <th className="text-center p-3 text-muted-foreground font-medium">Settled</th>
                          <th className="text-center p-3 text-muted-foreground font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {trades.map((t) => (
                          <tr key={t.id} className="hover:bg-white/5 transition-colors group">
                            <td className="p-3 max-w-[180px] truncate text-white" title={t.reasoning || undefined}>{t.title}</td>
                            <td className="p-3 text-xs text-muted-foreground">{t.strategyName}</td>
                            <td className="p-3 text-center">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${t.side === "yes" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                                {t.side}
                              </span>
                            </td>
                            <td className="p-3 text-right font-mono text-white">${t.entryPrice.toFixed(2)}</td>
                            <td className="p-3 text-right font-mono text-white">{t.edge.toFixed(1)}%</td>
                            <td className={`p-3 text-right font-mono ${t.clv != null ? (t.clv >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground"}`}>
                              {t.clv != null ? (t.clv * 100).toFixed(2) + "%" : "-"}
                            </td>
                            <td className={`p-3 text-right font-mono font-bold ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                              ${t.pnl.toFixed(2)}
                            </td>
                            <td className="p-3 text-center text-xs text-muted-foreground">{t.marketResult || "-"}</td>
                            <td className="p-3 text-center">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${t.outcome === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                                {t.outcome}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              Previous Runs
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {runs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No backtest runs yet. Configure and run your first backtest above.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-white/5 bg-black/10">
                    <tr>
                      <th className="text-left p-3 text-muted-foreground font-medium">ID</th>
                      <th className="text-left p-3 text-muted-foreground font-medium">Strategy</th>
                      <th className="text-left p-3 text-muted-foreground font-medium">Period</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Markets</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Trades</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
                      <th className="text-right p-3 text-muted-foreground font-medium">Win Rate</th>
                      <th className="text-center p-3 text-muted-foreground font-medium">Status</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {runs.map((r) => (
                      <tr key={r.id} className={`hover:bg-white/5 transition-colors ${selectedRunId === r.id ? "bg-primary/5" : ""}`}>
                        <td className="p-3 font-mono text-white">#{r.id}</td>
                        <td className="p-3 text-white">{r.strategyName}</td>
                        <td className="p-3 text-muted-foreground text-xs">{r.startDate} to {r.endDate}</td>
                        <td className="p-3 text-right font-mono text-white">{r.marketsEvaluated}</td>
                        <td className="p-3 text-right font-mono text-white">{r.tradesSimulated}</td>
                        <td className={`p-3 text-right font-mono font-bold ${r.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          ${r.totalPnl?.toFixed(2)}
                        </td>
                        <td className="p-3 text-right font-mono text-white">{(r.winRate * 100).toFixed(1)}%</td>
                        <td className="p-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${r.status === "completed" ? "bg-green-500/20 text-green-400" : r.status === "error" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="p-3">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedRunId(r.id)}
                            className="text-primary hover:text-primary/80"
                          >
                            View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
